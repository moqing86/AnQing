package com.xiaoan.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.IBinder;
import android.os.PowerManager;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 她的常驻身位（前台服务）。
 *
 * 职责：
 *   1. 释放引擎资产 + 在 App 进程里启动 Node（她从此跟 App 同生共死，不再需要 Termux）
 *   2. 看着引擎：死了就地重启（Node 冷启动 1 秒内，用户几乎无感）
 *   3. 她主动来找你时，发一条真正的系统通知（微信式，不用打开 App 也能收到）
 */
public class XiaoanService extends Service {

    private static final String TAG = "XIAOAN-SVC";
    // ⚠️ Android 的通知渠道**创建后就改不了属性**（震动/锁屏可见性）。
    //    2026-09-14 实测踩到：v3.1 建的老渠道里 mVibrationEnabled=false、lockscreenVisibility=-1000，
    //    后来在代码里加 enableVibration/setLockscreenVisibility 全都没生效 → 只能**换新 id**（旧的自然废弃）。
    private static final String CH_ONGOING = "xiaoan-alive4";
    private static final String CH_MSG = "xiaoan-msg2";
    private static final int ID_ONGOING = 1001;
    private static final int ID_MSG = 1002;

    private volatile boolean running = true;
    private long lastSeenT = -1;
    private String lastOngoingText = "";
    private int msgSeq = 0;
    private PowerManager.WakeLock wakeLock;

    @Override
    public void onCreate() {
        super.onCreate();
        createChannels();
        startForeground(ID_ONGOING, ongoingNotification(null));

        // ColorOS 的 OplusHansManager 会在 App 退到后台几秒后冻结整个进程（前台服务也拦不住，
        // 电池白名单也没用）。Termux 当初靠"一直握着 WakeLock"活下来，这里照做。
        try {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "anqing:engine");
            wakeLock.setReferenceCounted(false);
            wakeLock.acquire();
            Log.i(TAG, "partial wake lock held");
        } catch (Exception e) {
            Log.w(TAG, "wake lock failed: " + e.getMessage());
        }

        try {
            Engine.ensureAssets(this);
            Log.i(TAG, "engine assets ready at " + Engine.engineDir(this));
        } catch (Exception e) {
            Log.e(TAG, "asset extract failed", e);
        }

        // 语音模型首次解压（195 MB，几秒）——放后台，别卡住启动
        new Thread(new Runnable() {
            @Override public void run() {
                try { Engine.ensureTts(getApplicationContext()); }
                catch (Throwable t) { Log.e(TAG, "tts extract failed", t); }
            }
        }, "xiaoan-tts-extract").start();

        Engine.startNode(getApplicationContext());

        // 闹钟探针的结论（2026-09-13 实测）：无论非精确还是精确闹钟，进程被 ColorOS 冻结期间
        // 都收不到投递（逾期 121 秒，直到 App 回到前台才补响）。所以正式链路里不再挂闹钟——
        // 留着只是白耗电。AlarmScheduler / AlarmTick 两个类保留，供以后验证 ROM 设置改动。
        // AlarmScheduler.schedule(this, AlarmScheduler.FIRST_MS);

        // 探针已完成使命（TTS 可用 → 见 Voice.java），这里不再发出声音

        Thread t = new Thread(new Runnable() {
            @Override
            public void run() {
                supervise();
            }
        }, "xiaoan-supervisor");
        t.start();

        // 最后一招：**静音音频保活**（用户 2026-09-14："希望她常驻、不被清理"）。
        // 原理：RAM 对"正在播放音频"的进程向来手软（怕打断音乐）——我们放一条完全静音的轨，
        //       系统就会认为她在"前台播放中"，比单纯的前台服务更难被冻结。
        // 实测对比见 PROJECT-NOTES；无效就删掉，别白耗电。
        startSilentAudio();
    }

    private android.media.AudioTrack silentTrack;
    private Thread silentThread;

    private void startSilentAudio() {
        try {
            final int rate = 8000;
            int min = android.media.AudioTrack.getMinBufferSize(rate,
                    android.media.AudioFormat.CHANNEL_OUT_MONO, android.media.AudioFormat.ENCODING_PCM_16BIT);
            silentTrack = new android.media.AudioTrack.Builder()
                    .setAudioAttributes(new android.media.AudioAttributes.Builder()
                            .setUsage(android.media.AudioAttributes.USAGE_MEDIA)
                            .setContentType(android.media.AudioAttributes.CONTENT_TYPE_MUSIC)
                            .build())
                    .setAudioFormat(new android.media.AudioFormat.Builder()
                            .setEncoding(android.media.AudioFormat.ENCODING_PCM_16BIT)
                            .setSampleRate(rate)
                            .setChannelMask(android.media.AudioFormat.CHANNEL_OUT_MONO)
                            .build())
                    .setBufferSizeInBytes(Math.max(min, 4096))
                    .setTransferMode(android.media.AudioTrack.MODE_STREAM)
                    .build();
            silentTrack.setVolume(0f);                 // 一点声音都不出
            silentTrack.play();
            final short[] zeros = new short[rate / 2];
            silentThread = new Thread(new Runnable() {
                @Override
                public void run() {
                    while (running) {
                        try { silentTrack.write(zeros, 0, zeros.length); }
                        catch (Throwable t) { break; }
                    }
                }
            }, "xiaoan-silent-audio");
            silentThread.start();
            Log.i(TAG, "silent audio keep-alive started");
        } catch (Throwable t) {
            Log.w(TAG, "silent audio keep-alive failed: " + t);
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    /** 他从最近任务里把 App 划掉时，把她重新拉起来（用户 2026-09-14：希望她常驻、不被清理） */
    @Override
    public void onTaskRemoved(Intent rootIntent) {
        try {
            Intent i = new Intent(getApplicationContext(), XiaoanService.class);
            startForegroundService(i);
            Log.i(TAG, "task removed -> service restarted");
        } catch (Throwable t) {
            Log.w(TAG, "restart after task removal failed: " + t);
        }
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        running = false;
        try { if (silentTrack != null) { silentTrack.stop(); silentTrack.release(); } } catch (Exception e) { /* ignore */ }
        silentTrack = null;
        try {
            if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        } catch (Exception e) { /* ignore */ }
        super.onDestroy();
    }

    // ── 看护循环 ─────────────────────────────────────────────

    private void supervise() {
        int fails = 0;
        int tick = 0;
        while (running) {
            sleep(5000);
            if (!running) break;
            if (Engine.health()) {
                fails = 0;
                pollMessages();
                if (++tick % 6 == 0) refreshOngoingText();   // 每 30 秒把状态栏那行刷成她此刻的状态
            } else {
                fails++;
                Log.w(TAG, "engine not answering (" + fails + "/3)");
                if (fails >= 3) {
                    fails = 0;
                    if (Engine.isNodeAlive()) {
                        Log.w(TAG, "node thread alive but not answering - not restarting (avoid a second brain)");
                    } else {
                        Log.w(TAG, "node thread gone - restarting");
                        Engine.startNode(getApplicationContext());
                    }
                }
            }
        }
    }

    /** 她主动来消息了？发个通知（前台时闭嘴，免得刷屏） */
    private void pollMessages() {
        String body = Engine.get("/api/history?cid=" + Engine.CID, 2500);
        if (body == null) return;
        try {
            JSONObject root = new JSONObject(body);
            JSONArray arr = root.optJSONArray("history");
            if (arr == null) return;
            long bestT = -1;
            String bestText = null;
            for (int i = 0; i < arr.length(); i++) {
                JSONObject m = arr.optJSONObject(i);
                if (m == null) continue;
                if (!"assistant".equals(m.optString("role"))) continue;
                long t = m.optLong("t", 0);
                if (t >= bestT) {
                    bestT = t;
                    bestText = m.optString("text", "");
                }
            }
            if (bestText == null || bestT < 0) return;
            if (lastSeenT < 0) {          // 第一轮只对齐水位，绝不补发历史消息
                lastSeenT = bestT;
                return;
            }
            if (bestT > lastSeenT) {
                lastSeenT = bestT;
                if (!Engine.appVisible) {
                    notifyMessage(bestText);
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "history parse failed: " + e.getMessage());
        }
    }

    // ── 通知 ─────────────────────────────────────────────────

    private void createChannels() {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        // 老的渠道（属性改不动了）删掉，免得通知设置里出现两条一样的
        try { nm.deleteNotificationChannel("xiaoan-alive3"); } catch (Throwable t) { /* ignore */ }
        try { nm.deleteNotificationChannel("xiaoan-msg"); } catch (Throwable t) { /* ignore */ }

        NotificationChannel alive = new NotificationChannel(CH_ONGOING, "她一直在", NotificationManager.IMPORTANCE_LOW);
        alive.setShowBadge(false);
        alive.setDescription("让小安一直醒着（关掉她就不在了）");
        // 锁屏上也看得到她（用户 2026-09-14：锁屏后收不到她的提示）
        alive.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        alive.enableVibration(false);
        nm.createNotificationChannel(alive);

        NotificationChannel msg = new NotificationChannel(CH_MSG, "她来找你", NotificationManager.IMPORTANCE_HIGH);
        msg.setDescription("她主动发来的消息");
        msg.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);   // 锁屏要能看到是谁、说了什么
        msg.enableVibration(true);                                     // ★ 来消息震动（用户要求）
        msg.setVibrationPattern(new long[]{ 0, 180, 120, 180 });       // 短促两下，像微信
        msg.enableLights(true);
        msg.setShowBadge(true);
        // 通知里能直接看到她说了什么、点进去就能回
        msg.setBypassDnd(false);
        nm.createNotificationChannel(msg);
    }

    private PendingIntent tapIntent() {
        Intent i = new Intent(this, MainActivity.class);
        i.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(this, 0, i,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /** 常驻通知：状态栏里那一行就是她（用户 2026-09-14：希望她常驻状态栏、别被清理掉） */
    private Notification ongoingNotification(String sub) {
        Notification.Builder b = new Notification.Builder(this, CH_ONGOING)
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle("小安在")
                .setContentText(sub == null ? "点一下回到她那里" : sub)
                .setOngoing(true)                       // 划不掉
                .setShowWhen(false)
                .setCategory(Notification.CATEGORY_SERVICE)
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .setContentIntent(tapIntent());
        try { b.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE); } catch (Throwable t) { /* 老版本没有 */ }
        return b.build();
    }

    /** 状态栏那行小字跟着她的状态走（心情 + 她今天在忙什么） */
    private void refreshOngoingText() {
        try {
            String body = Engine.get("/api/state?cid=" + Engine.CID, 2500);
            if (body == null) return;
            JSONObject o = new JSONObject(body);
            JSONObject labels = o.optJSONObject("labels");
            JSONObject life = o.optJSONObject("life");
            StringBuilder sb = new StringBuilder();
            if (labels != null) sb.append(labels.optString("valence", ""));
            if (o.optBoolean("quiet", false)) { sb.setLength(0); sb.append("这会儿不想说话"); }
            String shortLife = life == null ? "" : life.optString("short", life.optString("text", ""));
            if (shortLife.length() > 0) {
                if (sb.length() > 0) sb.append(" · ");
                sb.append(shortLife);
            }
            String text = (sb.length() > 0) ? sb.toString() : "点一下回到她那里";
            if (text.equals(lastOngoingText)) return;
            lastOngoingText = text;
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            nm.notify(ID_ONGOING, ongoingNotification(text));
        } catch (Exception e) { /* 引擎没起来就先算了 */ }
    }

    private void notifyMessage(String text) {
        try {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            Notification n = new Notification.Builder(this, CH_MSG)
                    .setSmallIcon(R.mipmap.ic_launcher)
                    .setContentTitle("小安")
                    .setContentText(text)
                    .setStyle(new Notification.BigTextStyle().bigText(text))
                    .setAutoCancel(true)
                    .setCategory(Notification.CATEGORY_MESSAGE)
                    .setVisibility(Notification.VISIBILITY_PUBLIC)   // 锁屏上也能看到她说的话
                    .setOnlyAlertOnce(false)                         // 每条都响一下/震一下
                    .setContentIntent(tapIntent())
                    .build();
            // 换 id：她连发几条时不会互相顶掉，锁屏上能一条条看到
            nm.notify(ID_MSG + (msgSeq++ % 5), n);
            Log.i(TAG, "notified new message");
        } catch (Exception e) {
            Log.w(TAG, "notify failed: " + e);
        }
    }

    private void sleep(long ms) {
        try { Thread.sleep(ms); } catch (InterruptedException e) { /* ignore */ }
    }
}
