package com.xiaoan.app;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioDeviceInfo;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioRecord;
import android.media.MediaPlayer;
import android.media.MediaRecorder;
import android.webkit.WebView;

import java.io.File;
import java.io.FileOutputStream;

/**
 * AEC 探针（2026-10-19 · 1.3 真全双工的前置实验）
 *
 * 要回答的问题只有一个：**一边放她的声音、一边录音时，她的声音漏进麦克风多少？**
 * 漏得够小（回声消除够强），才能"她说话时麦克风一直开着 → 你一插话就打断她"；
 * 漏得太大，VAD 会被她自己的声音触发，真全双工就做不了，只能退回"半双工但更快"。
 *
 * 做法：同一个 wav 播一遍，用三种录音源各录一遍（音量、位置、时长都一样），存三个 wav 回电脑侧算 ERLE：
 *   mic          → 原始麦克风（**没有回声消除**）＝ 上限基准
 *   voicecomm    → VOICE_COMMUNICATION（通话源，系统通常挂 AEC）
 *   voicerec     → VOICE_RECOGNITION（识别源，App 现在用的就是这个）
 *   另外录一段"不放音"的静音底噪，用来扣掉环境噪声
 *
 * ERLE = 10 * log10(纯麦克风能量 / 消回声后能量)，越大越好（> 10 dB 才算有用）。
 */
public class AecProbe {

    private static final int RATE = 16000;
    private static final int CH = AudioFormat.CHANNEL_IN_MONO;
    private static final int ENC = AudioFormat.ENCODING_PCM_16BIT;
    private static final int MAX_MS = 9000;          // 单遍最长录 9 秒

    private static final int[] SOURCES = {
            MediaRecorder.AudioSource.MIC,
            MediaRecorder.AudioSource.VOICE_COMMUNICATION,
            MediaRecorder.AudioSource.VOICE_RECOGNITION,
            MediaRecorder.AudioSource.VOICE_COMMUNICATION,   // 最后一趟不放音，当底噪
    };
    private static final String[] NAMES = {"mic", "voicecomm", "voicerec", "silence"};
    private static final boolean[] PLAYED = {true, true, true, false};

    public static void run(final Context ctx, final WebView web, final String fileName) {
        new Thread(new Runnable() {
            @Override
            public void run() {
                StringBuilder out = new StringBuilder();
                String err = null;
                try {
                    File dir = new File(Engine.engineDir(ctx), "data/voice");
                    File wav = pickWav(dir, fileName);
                    if (wav == null || !wav.exists()) {
                        reply(web, "{\"ok\":false,\"error\":\"找不到可播放的 wav\"}");
                        return;
                    }
                    AudioManager am = (AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
                    int vol = am != null ? am.getStreamVolume(AudioManager.STREAM_MUSIC) : -1;
                    int volMax = am != null ? am.getStreamMaxVolume(AudioManager.STREAM_MUSIC) : -1;
                    int modeBefore = am != null ? am.getMode() : AudioManager.MODE_NORMAL;

                    // 按"真实通话"的姿态测：通话模式 + 扬声器（否则 VOICE_COMMUNICATION 可能把播放切到听筒，
                    // 测出来的"回声很小"其实是被路由骗了）
                    boolean speakerForced = false;
                    if (am != null) {
                        try {
                            am.setMode(AudioManager.MODE_IN_COMMUNICATION);
                            if (android.os.Build.VERSION.SDK_INT >= 31) {
                                for (AudioDeviceInfo d : am.getDevices(AudioManager.GET_DEVICES_OUTPUTS)) {
                                    if (d.getType() == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER) { am.setCommunicationDevice(d); speakerForced = true; break; }
                                }
                            } else {
                                am.setSpeakerphoneOn(true);
                                speakerForced = true;
                            }
                        } catch (Throwable ignore) { }
                    }

                    out.append("{\"ok\":true,\"file\":\"").append(wav.getName()).append("\",");
                    out.append("\"mediaVolume\":").append(vol).append(",\"mediaVolumeMax\":").append(volMax).append(",");
                    out.append("\"audioMode\":").append(am != null ? am.getMode() : -1).append(",");
                    out.append("\"speakerForced\":").append(speakerForced).append(",");
                    out.append("\"passes\":[");
                    boolean first = true;
                    File outDir = dir;
                    for (int i = 0; i < SOURCES.length; i++) {
                        Pass p = onePass(ctx, SOURCES[i], PLAYED[i], wav, outDir, NAMES[i]);
                        if (p == null) continue;
                        if (!first) out.append(",");
                        first = false;
                        out.append(p.toJson());
                    }
                    out.append("]}");

                    // 恢复
                    if (am != null) {
                        try {
                            if (android.os.Build.VERSION.SDK_INT >= 31) am.clearCommunicationDevice();
                            else am.setSpeakerphoneOn(false);
                            am.setMode(modeBefore);
                        } catch (Throwable ignore) { }
                    }
                } catch (Throwable t) {
                    err = String.valueOf(t);
                }
                if (err != null) {
                    reply(web, "{\"ok\":false,\"error\":\"" + esc(err) + "\"}");
                } else {
                    reply(web, out.toString());
                }
            }
        }, "xiaoan-aec").start();
    }

    private static File pickWav(File dir, String fileName) {
        if (fileName != null && fileName.length() > 0) {
            File f = new File(dir, fileName);
            if (f.exists()) return f;
        }
        File best = null;
        File[] fs = dir.listFiles();
        if (fs == null) return null;
        for (File f : fs) {
            if (!f.getName().toLowerCase().endsWith(".wav")) continue;
            if (f.getName().startsWith("probe-")) continue;
            if (f.length() < 20000) continue;                 // 太短的（"嗯"）不适合当回声源
            if (best == null || f.length() > best.length()) best = f;
        }
        return best;
    }

    private static class Pass {
        String name;
        int ms;
        int playMs;
        double rmsAll;
        double rmsPlay;
        double peak;
        int framesOver;         // 100ms 帧里超过 0.02 的个数（VAD 误触发倾向）
        int totalFrames;
        String file;
        int samples;

        String toJson() {
            java.util.Locale L = java.util.Locale.US;
            return "{\"name\":\"" + name + "\",\"ms\":" + ms + ",\"playMs\":" + playMs
                    + ",\"rms\":" + String.format(L, "%.4f", rmsAll)
                    + ",\"rmsPlay\":" + String.format(L, "%.4f", rmsPlay)
                    + ",\"peak\":" + String.format(L, "%.4f", peak)
                    + ",\"framesOver\":" + framesOver
                    + ",\"totalFrames\":" + totalFrames
                    + ",\"file\":\"" + (file == null ? "" : file) + "\""
                    + ",\"samples\":" + samples + "}";
        }
    }

    private static Pass onePass(Context ctx, int source, boolean play, File wav, File outDir, String name) {
        AudioRecord ar = null;
        MediaPlayer mp = null;
        try {
            int min = AudioRecord.getMinBufferSize(RATE, CH, ENC);
            if (min <= 0) min = 8192;
            ar = new AudioRecord(source, RATE, CH, ENC, Math.max(min * 4, 16384));
            if (ar.getState() != AudioRecord.STATE_INITIALIZED) {
                try { ar.release(); } catch (Throwable ignore) { }
                return null;
            }

            short[] buf = new short[RATE * (MAX_MS / 1000)];
            int len = 0;
            ar.startRecording();

            int playMs = 0;
            if (play) {
                try {
                    mp = new MediaPlayer();
                    mp.setAudioAttributes(new AudioAttributes.Builder()
                            .setUsage(AudioAttributes.USAGE_MEDIA)
                            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                            .build());
                    mp.setDataSource(wav.getAbsolutePath());
                    mp.prepare();
                    playMs = mp.getDuration();
                    Thread.sleep(150);                 // 先录一点静音，方便对齐
                    mp.start();
                } catch (Throwable t) {
                    System.out.println("aecProbe play failed: " + t);
                }
            }

            short[] tmp = new short[1600];
            long t0 = System.currentTimeMillis();
            while (len < buf.length) {
                int n;
                try { n = ar.read(tmp, 0, tmp.length); } catch (Throwable t) { break; }
                if (n <= 0) continue;
                int take = Math.min(n, buf.length - len);
                System.arraycopy(tmp, 0, buf, len, take);
                len += take;
                long el = System.currentTimeMillis() - t0;
                if (play && playMs > 0 && el > playMs + 700) break;      // 放完再录 0.7 秒收尾
                if (!play && el > 2500) break;                            // 底噪录 2.5 秒就够了
            }

            try { ar.stop(); } catch (Throwable ignore) { }
            try { ar.release(); } catch (Throwable ignore) { }
            ar = null;
            if (mp != null) { try { mp.stop(); mp.release(); } catch (Throwable ignore) { } mp = null; }

            Pass p = new Pass();
            p.name = name;
            p.samples = len;
            p.ms = (int) Math.round(len * 1000.0 / RATE);
            p.playMs = playMs;

            double sum = 0, sumPlay = 0, peak = 0;
            int playSamples = play ? Math.min(len, (int) ((playMs + 150L) * RATE / 1000)) : 0;
            for (int i = 0; i < len; i++) {
                double v = buf[i] / 32768.0;
                sum += v * v;
                if (Math.abs(v) > peak) peak = Math.abs(v);
                if (i < playSamples) sumPlay += v * v;
            }
            p.rmsAll = len > 0 ? Math.sqrt(sum / len) : 0;
            p.rmsPlay = playSamples > 0 ? Math.sqrt(sumPlay / playSamples) : 0;
            p.peak = peak;

            int frame = RATE / 10;                       // 100ms
            p.totalFrames = len / frame;
            int over = 0;
            for (int i = 0; i + frame <= len; i += frame) {
                double s = 0;
                for (int j = 0; j < frame; j++) { double v = buf[i + j] / 32768.0; s += v * v; }
                if (Math.sqrt(s / frame) > 0.020) over++;
            }
            p.framesOver = over;

            File out = new File(outDir, "probe-" + name + ".wav");
            writeWav(out, buf, len);
            p.file = out.getName();
            return p;
        } catch (Throwable t) {
            System.out.println("aecProbe pass " + name + " failed: " + t);
            return null;
        } finally {
            if (ar != null) { try { ar.stop(); } catch (Throwable ignore) { } try { ar.release(); } catch (Throwable ignore) { } }
            if (mp != null) { try { mp.stop(); mp.release(); } catch (Throwable ignore) { } }
        }
    }

    private static void writeWav(File f, short[] data, int len) {
        FileOutputStream fos = null;
        try {
            fos = new FileOutputStream(f);
            int dataLen = len * 2;
            byte[] h = new byte[44];
            writeStr(h, 0, "RIFF");
            writeInt(h, 4, 36 + dataLen);
            writeStr(h, 8, "WAVE");
            writeStr(h, 12, "fmt ");
            writeInt(h, 16, 16);
            writeShort(h, 20, 1);          // PCM
            writeShort(h, 22, 1);          // mono
            writeInt(h, 24, RATE);
            writeInt(h, 28, RATE * 2);
            writeShort(h, 32, 2);
            writeShort(h, 34, 16);
            writeStr(h, 36, "data");
            writeInt(h, 40, dataLen);
            fos.write(h);
            byte[] b = new byte[dataLen];
            for (int i = 0; i < len; i++) {
                b[i * 2] = (byte) (data[i] & 0xff);
                b[i * 2 + 1] = (byte) ((data[i] >> 8) & 0xff);
            }
            fos.write(b);
            fos.flush();
        } catch (Throwable t) {
            System.out.println("aecProbe write wav failed: " + t);
        } finally {
            if (fos != null) { try { fos.close(); } catch (Throwable ignore) { } }
        }
    }

    private static void writeStr(byte[] a, int off, String s) {
        for (int i = 0; i < s.length(); i++) a[off + i] = (byte) s.charAt(i);
    }

    private static void writeInt(byte[] a, int off, int v) {
        a[off] = (byte) (v & 0xff);
        a[off + 1] = (byte) ((v >> 8) & 0xff);
        a[off + 2] = (byte) ((v >> 16) & 0xff);
        a[off + 3] = (byte) ((v >> 24) & 0xff);
    }

    private static void writeShort(byte[] a, int off, int v) {
        a[off] = (byte) (v & 0xff);
        a[off + 1] = (byte) ((v >> 8) & 0xff);
    }

    private static String esc(String s) {
        if (s == null) return "";
        return s.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", " ").replace("\r", " ");
    }

    private static void reply(final WebView web, final String json) {
        if (web == null) return;
        web.post(new Runnable() {
            @Override
            public void run() {
                try {
                    web.evaluateJavascript("window.onAecProbe&&onAecProbe('" + esc(json) + "')", null);
                } catch (Throwable ignore) { }
            }
        });
    }
}
