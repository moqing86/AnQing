package com.xiaoan.app;

import android.content.Context;
import android.content.Intent;
import android.media.AudioDeviceInfo;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import java.util.ArrayList;

/**
 * 「按住说话」的耳朵（三期 · 实时通话 v1）。
 *
 * 页面侧：AnqingNative 之外再挂一个 AnqingSpeech：
 *   AnqingSpeech.available()  系统有没有语音识别
 *   AnqingSpeech.start()      开始听（页面按下麦克风时调）
 *   AnqingSpeech.stop()       松开：让引擎收尾出最终结果
 *   AnqingSpeech.cancel()     取消（划走/长按取消）
 * 回调（页面里定义 window.onUserSpeech(kind, text)）：
 *   kind = start | partial | final | end | error
 *
 * 走系统 SpeechRecognizer（ColorOS 自带离线/在线识别），不额外塞模型，APK 不长大。
 */
public class VoiceInput {

    private final Context ctx;
    private final WebView web;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private SpeechRecognizer sr;
    private boolean listening = false;

    public VoiceInput(Context c, WebView w) {
        ctx = c;
        web = w;
    }

    private static String esc(String s) {
        if (s == null) return "";
        return s.replace("\\", "\\\\").replace("'", "\\'").replace("\n", " ").replace("\r", " ");
    }

    private void cb(final String kind, final String text) {
        ui.post(new Runnable() {
            @Override
            public void run() {
                try {
                    web.evaluateJavascript("window.onUserSpeech&&onUserSpeech('" + esc(kind) + "','" + esc(text) + "')", null);
                } catch (Throwable t) { /* 页面没了就算了 */ }
            }
        });
    }

    @JavascriptInterface
    public boolean available() {
        try { return SpeechRecognizer.isRecognitionAvailable(ctx); } catch (Throwable t) { return false; }
    }

    /** 手机自带的离线识别（SenseVoice）在不在 —— 模型打进 APK 里了，正常情况下永远 true */
    @JavascriptInterface
    public boolean offlineReady() {
        java.io.InputStream in = null;
        try {
            in = ctx.getAssets().open("asr/asr.zip");
            return true;
        } catch (Throwable t) {
            return false;
        } finally {
            if (in != null) { try { in.close(); } catch (Throwable ignored) { } }
        }
    }

    /**
     * 离线识别：页面录完音，把 16k 单声道 Int16 PCM 用 base64 丢过来（识在后台线程，出结果回调 onUserSpeech）。
     * 第一次调用会把 227 MB 模型解压出来，会慢几秒——所以先回一句"在听"给页面。
     */
    @JavascriptInterface
    public void transcribe(final String b64, final int rate) {
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    byte[] raw = android.util.Base64.decode(b64, android.util.Base64.NO_WRAP);
                    int n = raw.length / 2;
                    if (n < 1600) { cb("error", "太短了，没听清"); return; }
                    float[] f = new float[n];
                    for (int i = 0; i < n; i++) {
                        short v = (short) ((raw[i * 2] & 0xff) | (raw[i * 2 + 1] << 8));
                        f[i] = v / 32768.0f;
                    }
                    String text = SherpaAsr.transcribe(ctx, f, rate > 0 ? rate : 16000);
                    if (text == null) cb("error", "识别器没起来（模型可能没解压完）");
                    else if (text.isEmpty()) cb("error", "没听清");
                    else cb("final", text);
                } catch (Throwable t) {
                    cb("error", "识别出错：" + t.getMessage());
                }
            }
        }).start();
    }

    private void ensure() {
        if (sr != null) return;
        sr = SpeechRecognizer.createSpeechRecognizer(ctx);
        sr.setRecognitionListener(new RecognitionListener() {
            @Override public void onReadyForSpeech(Bundle params) { cb("start", ""); }
            @Override public void onBeginningOfSpeech() { }
            @Override public void onRmsChanged(float rmsdB) { }
            @Override public void onBufferReceived(byte[] buffer) { }
            @Override public void onEndOfSpeech() { cb("end", ""); }
            @Override public void onError(int error) {
                listening = false;
                cb("error", errName(error));
            }
            @Override public void onResults(Bundle results) {
                listening = false;
                cb("final", first(results));
            }
            @Override public void onPartialResults(Bundle partialResults) {
                cb("partial", first(partialResults));
            }
            @Override public void onEvent(int eventType, Bundle params) { }
        });
    }

    private static String first(Bundle b) {
        if (b == null) return "";
        ArrayList<String> list = b.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        return (list != null && !list.isEmpty() && list.get(0) != null) ? list.get(0) : "";
    }

    private static String errName(int code) {
        switch (code) {
            case SpeechRecognizer.ERROR_AUDIO: return "录音出错";
            case SpeechRecognizer.ERROR_CLIENT: return "客户端出错";
            case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS: return "没有麦克风权限";
            case SpeechRecognizer.ERROR_NETWORK: return "网络不好";
            case SpeechRecognizer.ERROR_NETWORK_TIMEOUT: return "网络超时";
            case SpeechRecognizer.ERROR_NO_MATCH: return "没听清";
            case SpeechRecognizer.ERROR_RECOGNIZER_BUSY: return "识别器忙";
            case SpeechRecognizer.ERROR_SERVER: return "识别服务出错";
            case SpeechRecognizer.ERROR_SPEECH_TIMEOUT: return "没听到声音";
            default: return "识别出错(" + code + ")";
        }
    }

    /**
     * 原生录音（16k 单声道 PCM）—— "按住说话"走这条。
     * 为什么不用网页的 getUserMedia：实测 WebView 那边直接 NotReadableError（起不了音频源），
     * 原生 AudioRecord 更好控、拿到的就是识别器要的格式，不用解 webm/opus、也不用重采样。
     */
    private AudioRecord ar;
    private Thread recThread;
    private volatile boolean recording = false;
    private short[] recBuf;
    private int recLen = 0;
    private static final int REC_RATE = 16000;
    private static final int REC_MAX_SEC = 60;

    /** 录音 → 识别（stopRec 与 listenOnce 共用）*/
    private void transcribeAsync(final int n, final short[] data) {
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    if (n < 3200) { cb("error", "太短了，没听清"); return; }   // <0.2 秒
                    float[] f = new float[n];
                    for (int i = 0; i < n; i++) f[i] = data[i] / 32768.0f;
                    String text = SherpaAsr.transcribe(ctx, f, REC_RATE);
                    if (text == null) cb("error", "识别器没起来（模型可能还没解压完）");
                    else if (text.isEmpty()) cb("error", "没听清");
                    else cb("final", text);
                } catch (Throwable t) {
                    cb("error", "识别出错：" + t.getMessage());
                }
            }
        }).start();
    }

    private void finishRecording() {
        recording = false;
        try { if (recThread != null) recThread.join(1200); } catch (Throwable t) { /* ignore */ }
        try { if (ar != null) ar.stop(); } catch (Throwable t) { /* ignore */ }
        try { if (ar != null) ar.release(); } catch (Throwable t) { /* ignore */ }
        ar = null;
    }

    /**
     * 连续对话用：**录到"他说完"为止**（不用按键）。
     * 简单 VAD：出声之后连续静音 ~0.9 秒就算说完；最长 20 秒兜底。
     */
    @JavascriptInterface
    public void listenOnce() {
        ui.post(new Runnable() {
            @Override
            public void run() {
                try {
                    if (recording) return;
                    int min = AudioRecord.getMinBufferSize(REC_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
                    if (min <= 0) { cb("error", "这台机器不支持 16k 录音"); return; }
                    // 真全双工（2026-10-19）：通话改走 VOICE_COMMUNICATION —— 实测它挂的系统回声消除更强
                    // （同一次 AEC 探针：VOICE_COMMUNICATION 压 33.5dB / 误触发 0 帧，VOICE_RECOGNITION 压 26.4dB / 误触发 4 帧）
                    ar = new AudioRecord(MediaRecorder.AudioSource.VOICE_COMMUNICATION, REC_RATE,
                            AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, Math.max(min * 4, 8192));
                    if (ar.getState() != AudioRecord.STATE_INITIALIZED) {
                        cb("error", "麦克风打不开（可能被别的应用占着）");
                        try { ar.release(); } catch (Throwable t) { /* ignore */ }
                        ar = null;
                        return;
                    }
                    recBuf = new short[REC_RATE * 20];
                    recLen = 0;
                    recording = true;
                    ar.startRecording();
                    cb("start", "");
                    recThread = new Thread(new Runnable() {
                        @Override
                        public void run() {
                            short[] tmp = new short[1600];
                            long startedAt = System.currentTimeMillis();
                            long lastVoiceAt = 0;
                            boolean heard = false;
                            int loudFrames = 0;
                            boolean barged = false;
                            while (recording && recLen < recBuf.length) {
                                int n;
                                try { n = ar.read(tmp, 0, tmp.length); } catch (Throwable t) { break; }
                                if (n <= 0) continue;
                                int take = Math.min(n, recBuf.length - recLen);
                                System.arraycopy(tmp, 0, recBuf, recLen, take);
                                recLen += take;
                                double sum = 0;
                                for (int i = 0; i < n; i++) { double v = tmp[i] / 32768.0; sum += v * v; }
                                double rms = Math.sqrt(sum / Math.max(1, n));
                                long now = System.currentTimeMillis();
                                if (rms > 0.020) { heard = true; lastVoiceAt = now; loudFrames++; }
                                else { loudFrames = 0; }
                                // 真全双工：他一开始说话就先喊一声，页面立刻把她正在说的话掐掉（打断）
                                if (!barged && loudFrames >= 3) { barged = true; cb("barge", ""); }
                                long total = now - startedAt;
                                if (total > 20000) break;                                    // 最多 20 秒
                                if (heard && now - lastVoiceAt > 900 && total > 1200) break; // 他说完了
                            }
                            final int n2 = recLen;
                            final short[] data = recBuf;
                            finishRecording();
                            transcribeAsync(n2, data);
                        }
                    }, "xiaoan-listen");
                    recThread.start();
                } catch (Throwable t) {
                    recording = false;
                    cb("error", "录音起不来：" + t.getMessage());
                }
            }
        });
    }

    @JavascriptInterface
    public void startRec() {
        ui.post(new Runnable() {
            @Override
            public void run() {
                try {
                    if (recording) return;
                    int min = AudioRecord.getMinBufferSize(REC_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
                    if (min <= 0) { cb("error", "这台机器不支持 16k 录音"); return; }
                    ar = new AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, REC_RATE,
                            AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, Math.max(min * 4, 8192));
                    if (ar.getState() != AudioRecord.STATE_INITIALIZED) {
                        cb("error", "麦克风打不开（可能被别的应用占着）");
                        try { ar.release(); } catch (Throwable t) { /* ignore */ }
                        ar = null;
                        return;
                    }
                    recBuf = new short[REC_RATE * REC_MAX_SEC];
                    recLen = 0;
                    recording = true;
                    ar.startRecording();
                    recThread = new Thread(new Runnable() {
                        @Override
                        public void run() {
                            short[] tmp = new short[1600];
                            while (recording && recLen < recBuf.length) {
                                int n;
                                try { n = ar.read(tmp, 0, tmp.length); } catch (Throwable t) { break; }
                                if (n > 0) {
                                    int room = recBuf.length - recLen;
                                    int take = Math.min(n, room);
                                    System.arraycopy(tmp, 0, recBuf, recLen, take);
                                    recLen += take;
                                }
                            }
                        }
                    });
                    recThread.start();
                    cb("start", "");
                } catch (Throwable t) {
                    recording = false;
                    cb("error", "录音起不来：" + t.getMessage());
                }
            }
        });
    }

    @JavascriptInterface
    public void stopRec() {
        ui.post(new Runnable() {
            @Override
            public void run() {
                if (!recording) return;
                finishRecording();
                transcribeAsync(recLen, recBuf);
            }
        });
    }

    @JavascriptInterface
    public boolean recordingNow() { return recording; }

    /**
     * 通话音频（2026-10-19 · 回退版）
     *
     * 上一版这里会把音频切到 MODE_IN_COMMUNICATION 并强制外放，结果用户实测"她的声音像鬼叫"——
     * 那套路由会把她的话塞进 VoIP 处理链，听感变闷、还可能被反复打断。**现在这里什么都不做**，
     * 保持系统默认路由（媒体走外放），回声抑制交给录音源本身（VOICE_COMMUNICATION）。
     * 方法保留着，免得旧页面调用时报错。
     */
    @JavascriptInterface
    public void callAudio(final boolean on) {
        // 故意留空
    }

    /**
     * AEC 探针（2026-10-19 · 1.3 真全双工前置实验）
     * 页面调 aecProbe() 或 aecProbe('ack-4.wav')：一边放她的声音、一边用三种录音源各录一遍，
     * 结果通过 window.onAecProbe(json) 回给页面；wav 落在 files/engine/data/voice/probe-*.wav
     */
    @JavascriptInterface
    public void aecProbe(final String fileName) {
        AecProbe.run(ctx, web, fileName);
    }

    @JavascriptInterface
    public void start() {        ui.post(new Runnable() {
            @Override
            public void run() {
                try {
                    ensure();
                    Intent i = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
                    i.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
                    i.putExtra(RecognizerIntent.EXTRA_LANGUAGE, "zh-CN");
                    i.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
                    i.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
                    i.putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, ctx.getPackageName());
                    listening = true;
                    sr.startListening(i);
                } catch (Throwable t) {
                    listening = false;
                    cb("error", "启动不了：" + t.getMessage());
                }
            }
        });
    }

    @JavascriptInterface
    public void stop() {
        ui.post(new Runnable() {
            @Override
            public void run() {
                try { if (sr != null && listening) sr.stopListening(); } catch (Throwable t) { /* ignore */ }
            }
        });
    }

    @JavascriptInterface
    public void cancel() {
        ui.post(new Runnable() {
            @Override
            public void run() {
                listening = false;
                try { if (sr != null) sr.cancel(); } catch (Throwable t) { /* ignore */ }
            }
        });
    }
}
