package com.xiaoan.app;

import android.content.Context;
import android.os.Bundle;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.util.Log;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import java.io.File;
import java.util.Locale;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * 她的嗓子（语音条）。
 *
 * Android WebView 里没有 speechSynthesis（实测 API=false），所以走原生：
 * 页面调 speak(text, id) -> 系统 TTS 合成到 files/engine/data/voice/&lt;id&gt;.wav
 * -> 回调页面 onVoiceReady(id) -> 页面用 /voice/&lt;id&gt;.wav 播出来。
 *
 * 实测（2026-09-13，一加 Ace3 / Android 16）：
 *   引擎 com.oplus.ttsaccessibilityengine，语言 [usa, chn]，setLanguage(zh)=1，
 *   synthesizeToFile=0(SUCCESS)，"你好，我是小安。" -> 73,004 字节 wav。
 */
public final class Voice {

    private static final String TAG = "XIAOAN-VOICE";

    private static TextToSpeech tts;
    private static boolean inited = false;

    private final Context ctx;
    private final WebView web;

    public Voice(Context context, WebView webView) {
        this.ctx = context.getApplicationContext();
        this.web = webView;
    }

    /** 页面问：她的嗓子能用吗 */
    @JavascriptInterface
    public boolean ok() {
        return init();
    }

    private boolean init() {
        synchronized (Voice.class) {
            if (tts != null) return inited;
            final CountDownLatch latch = new CountDownLatch(1);
            tts = new TextToSpeech(ctx, new TextToSpeech.OnInitListener() {
                @Override
                public void onInit(int status) {
                    inited = (status == TextToSpeech.SUCCESS);
                    if (inited) {
                        try {
                            int r = tts.setLanguage(Locale.CHINESE);
                            Log.i(TAG, "setLanguage=" + r);
                        } catch (Throwable t) {
                            Log.w(TAG, "setLanguage failed: " + t);
                        }
                    }
                    latch.countDown();
                }
            });
            try { latch.await(20, TimeUnit.SECONDS); } catch (InterruptedException e) { /* ignore */ }
            if (inited) {
                tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                    @Override public void onStart(String id) { }
                    @Override public void onDone(String id) { callJs("onVoiceReady", id); }
                    @Override public void onError(String id) { callJs("onVoiceError", id); }
                    @Override public void onError(String id, int code) { callJs("onVoiceError", id); }
                });
            }
            Log.i(TAG, "init done, usable=" + inited);
            return inited;
        }
    }

    /** 页面调：把这句话合成成 <id>.wav（已存在就直接回调，不重复合成）
     *  rate/pitch 用来把手机自带的读屏音色调年轻一点（1.0 = 原声） */
    @JavascriptInterface
    public void speak(final String text, final String id) {
        speak(text, id, 1.0f, 1.0f);
    }

    @JavascriptInterface
    public void speak(final String text, final String id, final float rate, final float pitch) {
        try {
            if (text == null || text.trim().isEmpty()) { callJs("onVoiceError", id); return; }

            // ① 首选：本地离线神经语音（sherpa-onnx + ZipVoice 克隆，绘梨衣音色）
            try {
                File vdir = new File(Engine.engineDir(ctx), "data/voice");
                if (!vdir.exists() && !vdir.mkdirs()) Log.w(TAG, "cannot mkdir " + vdir);
                File vout = new File(vdir, id + ".wav");
                if (vout.exists() && vout.length() > 44) { callJs("onVoiceReady", id); return; }
                if (SherpaTts.ready(ctx) && SherpaTts.speak(ctx, text, vout)) {
                    Log.i(TAG, "spoken by local neural tts: " + id);
                    callJs("onVoiceReady", id);
                    return;
                }
                Log.w(TAG, "local neural tts unavailable, falling back to system tts");
            } catch (Throwable t) {
                Log.w(TAG, "local tts failed: " + t);
            }

            // ② 兜底：手机自带 TTS（离线可用，但音色是读屏腔）
            if (!init()) { callJs("onVoiceError", id); return; }
            try {
                tts.setSpeechRate(rate > 0.3f && rate < 2.5f ? rate : 1.0f);
                tts.setPitch(pitch > 0.3f && pitch < 2.5f ? pitch : 1.0f);
            } catch (Throwable t) { /* 引擎不支持就算了 */ }
            File dir = new File(Engine.engineDir(ctx), "data/voice");
            if (!dir.exists() && !dir.mkdirs()) { Log.w(TAG, "no dir " + dir); callJs("onVoiceError", id); return; }
            File out = new File(dir, id + ".wav");
            if (out.exists() && out.length() > 44) { callJs("onVoiceReady", id); return; }
            Bundle params = new Bundle();
            int r = tts.synthesizeToFile(text, params, out, id);
            Log.i(TAG, "synth id=" + id + " r=" + r + " chars=" + text.length()
                    + " rate=" + rate + " pitch=" + pitch);
            if (r != TextToSpeech.SUCCESS) callJs("onVoiceError", id);
        } catch (Throwable t) {
            Log.e(TAG, "speak crashed", t);
            callJs("onVoiceError", id);
        }
    }

    @JavascriptInterface
    public void stop() {
        try { if (tts != null) tts.stop(); } catch (Throwable t) { /* ignore */ }
    }

    private void callJs(final String fn, final String id) {
        if (web == null) return;
        final String js = "window." + fn + " && window." + fn + "('" + String.valueOf(id).replace("'", "") + "')";
        web.post(new Runnable() {
            @Override public void run() {
                try { web.evaluateJavascript(js, null); } catch (Throwable t) { /* ignore */ }
            }
        });
    }
}
