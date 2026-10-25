package com.xiaoan.app;

import android.content.Context;
import android.util.Log;

import com.k2fsa.sherpa.onnx.FeatureConfig;
import com.k2fsa.sherpa.onnx.OfflineModelConfig;
import com.k2fsa.sherpa.onnx.OfflineRecognizer;
import com.k2fsa.sherpa.onnx.OfflineRecognizerConfig;
import com.k2fsa.sherpa.onnx.OfflineRecognizerResult;
import com.k2fsa.sherpa.onnx.OfflineSenseVoiceModelConfig;
import com.k2fsa.sherpa.onnx.OfflineStream;

import java.io.File;

/**
 * 她的耳朵：手机本地离线语音识别（sherpa-onnx + SenseVoice int8）。
 *
 * 为什么不用系统识别：这台一加（ColorOS）**压根没有语音识别服务**
 * （实测 `pm query-services -a android.speech.RecognitionService` → No services found），
 * 所以"按住说话"只能自带模型。SenseVoice 一次能出中英日韩粤，还能带标点/情绪标记。
 *
 * 和 TTS 同一套架构：模型打 zip 进 assets → 首次用到解压 → 全在本地跑、不联网、免费。
 */
public final class SherpaAsr {

    private static final String TAG = "XIAOAN-ASR";
    private static final int NUM_THREADS = 2;

    private static OfflineRecognizer rec;
    private static boolean tried = false;

    private SherpaAsr() { }

    public static synchronized boolean ready(Context ctx) {
        if (tried) return rec != null;
        tried = true;
        try {
            Engine.ensureAsr(ctx);
            File dir = Engine.asrDir(ctx);
            File model = new File(dir, "model.int8.onnx");
            File tokens = new File(dir, "tokens.txt");
            if (!model.exists() || !tokens.exists()) {
                Log.e(TAG, "asr model missing in " + dir);
                return false;
            }
            String base = dir.getAbsolutePath();
            OfflineSenseVoiceModelConfig sv = new OfflineSenseVoiceModelConfig();
            sv.setModel(base + "/model.int8.onnx");
            sv.setLanguage("zh");
            sv.setUseInverseTextNormalization(true);   // 把"二零二六年"这类顺回来

            // ⚠️ Kotlin data class 的参数是非空类型：无参构造 + setter 最省事（TTS 那边踩过）
            OfflineModelConfig mc = new OfflineModelConfig();
            mc.setSenseVoice(sv);
            mc.setTokens(base + "/tokens.txt");
            mc.setNumThreads(NUM_THREADS);
            mc.setDebug(false);
            mc.setProvider("cpu");

            OfflineRecognizerConfig cfg = new OfflineRecognizerConfig();
            cfg.setModelConfig(mc);
            cfg.setFeatConfig(new FeatureConfig());    // 默认 16k / 80 维

            long t0 = System.currentTimeMillis();
            rec = new OfflineRecognizer(null, cfg);    // null = 走文件系统（模型已解压在 filesDir）
            Log.i(TAG, "asr loaded in " + (System.currentTimeMillis() - t0) + "ms");
            return true;
        } catch (Throwable t) {
            Log.e(TAG, "asr init failed", t);
            rec = null;
            return false;
        }
    }

    /** samples 是 16k 单声道 float；成功返回文字（可能是空串 = 没听清），失败返回 null */
    public static synchronized String transcribe(Context ctx, float[] samples, int rate) {
        if (samples == null || samples.length < 1600) return "";     // 不足 0.1 秒：当没说话
        if (!ready(ctx)) return null;
        try {
            long t0 = System.currentTimeMillis();
            OfflineStream s = rec.createStream();
            s.acceptWaveform(samples, rate);
            rec.decode(s);
            OfflineRecognizerResult r = rec.getResult(s);
            String text = (r == null) ? "" : String.valueOf(r.getText());
            try { s.release(); } catch (Throwable t) { /* ignore */ }
            Log.i(TAG, "asr " + (System.currentTimeMillis() - t0) + "ms: " + text);
            return text == null ? "" : text.trim();
        } catch (Throwable t) {
            Log.e(TAG, "asr failed", t);
            return null;
        }
    }

    public static synchronized void release() {
        try { if (rec != null) rec.release(); } catch (Throwable t) { /* ignore */ }
        rec = null;
        tried = false;
    }
}
