package com.xiaoan.app;

import android.content.Context;
import android.util.Log;

import com.k2fsa.sherpa.onnx.GenerationConfig;
import com.k2fsa.sherpa.onnx.GeneratedAudio;
import com.k2fsa.sherpa.onnx.OfflineTts;
import com.k2fsa.sherpa.onnx.OfflineTtsConfig;
import com.k2fsa.sherpa.onnx.OfflineTtsModelConfig;
import com.k2fsa.sherpa.onnx.OfflineTtsZipVoiceModelConfig;

import java.io.File;
import java.io.FileInputStream;
import java.util.HashMap;

/**
 * 她的嗓子 v2：本地离线神经语音（sherpa-onnx + ZipVoice 零样本克隆）。
 *
 * 和 v1（系统 TTS）的区别：这里能把参考音频里的音色学过来 → 用绘梨衣的声音说任何新话。
 * 实测基准（PC，参考 9.08 秒）：int8 合成约 19 秒/条、fp32 约 30 秒/条。
 *
 * 关键坑（都在 PC 上踩过）：
 *   * 参考音频 5~10 秒、干净无配乐、单声道 16bit —— 太短音色会随文本漂
 *   * 阿拉伯数字会被 espeak 当 OOV 丢掉（"背 20 个单词" → "背 个单词"）→ 先转中文数字
 *   * 模型零件必须同源（编码器/解码器/声码器）——混用会出现"两种音色打架"
 */
public final class SherpaTts {

    private static final String TAG = "XIAOAN-SHERPA";
    private static final int NUM_STEPS = 16;      // 8 步偏糊，16 步明显更稳
    private static final int NUM_THREADS = 2;     // 手机上 2 线程够用，别把 CPU 吃满

    private static OfflineTts tts;
    private static float[] refAudio;
    private static int refRate = 24000;
    private static String refText = "";
    private static boolean tried = false;

    private SherpaTts() { }

    /** 模型/参考音频都就绪了才返回 true（首次会解压 ~195 MB，几秒钟） */
    public static synchronized boolean ready(Context ctx) {
        if (tried) return tts != null;
        tried = true;
        try {
            Engine.ensureTts(ctx);
            File dir = Engine.ttsDir(ctx);
            File enc = new File(dir, "encoder.int8.onnx");
            File dec = new File(dir, "decoder.int8.onnx");
            File voc = new File(dir, "vocos_24khz.onnx");
            File tok = new File(dir, "tokens.txt");
            File lex = new File(dir, "lexicon.txt");
            File esp = new File(dir, "espeak-ng-data");
            if (!enc.exists() || !dec.exists() || !voc.exists() || !tok.exists() || !lex.exists()) {
                Log.e(TAG, "model files missing in " + dir);
                return false;
            }
            String base = dir.getAbsolutePath();
            OfflineTtsZipVoiceModelConfig zip = new OfflineTtsZipVoiceModelConfig(
                    base + "/tokens.txt",
                    base + "/encoder.int8.onnx",
                    base + "/decoder.int8.onnx",
                    base + "/vocos_24khz.onnx",
                    esp.exists() ? base + "/espeak-ng-data" : "",
                    base + "/lexicon.txt",
                    0.1f, 0.5f, 0.1f, 1.0f);        // 官方默认值
            // ⚠️ Kotlin 的 data class 参数是非空类型：传 null 会被空检查拦下
            //    （踩过：NullPointerException: parameter vits）；
            //    带默认值的合成构造器 javac 又看不见 → 用"无参构造 + setter"最省事。
            OfflineTtsModelConfig mc = new OfflineTtsModelConfig();   // 全部走 Kotlin 默认值
            mc.setZipvoice(zip);
            mc.setNumThreads(NUM_THREADS);
            mc.setDebug(false);
            mc.setProvider("cpu");
            OfflineTtsConfig cfg = new OfflineTtsConfig(mc, "", "", 1, 0.2f);

            long t0 = System.currentTimeMillis();
            tts = new OfflineTts(null, cfg);           // 传 null => 用 newFromFile（模型在文件系统里）
            Log.i(TAG, "model loaded in " + (System.currentTimeMillis() - t0) + "ms"
                    + "  speakers=" + tts.numSpeakers() + "  sr=" + tts.sampleRate());

            File refWav = new File(dir, "ref.wav");
            File refTxt = new File(dir, "ref.txt");
            if (refWav.exists()) readWav(refWav);
            if (refTxt.exists()) refText = readText(refTxt).trim();
            Log.i(TAG, "reference: " + (refAudio == null ? "none" : (refAudio.length + " samples @" + refRate))
                    + "  text=" + (refText.length() > 20 ? refText.substring(0, 20) + "..." : refText));
            return true;
        } catch (Throwable t) {
            Log.e(TAG, "init failed", t);
            tts = null;
            return false;
        }
    }

    /** 合成一段话到 outWav；成功返回 true */
    public static synchronized boolean speak(Context ctx, String text, File outWav) {
        if (!ready(ctx)) return false;
        if (refAudio == null || refText.isEmpty()) {
            Log.w(TAG, "no reference audio/text");
            return false;
        }
        if (text == null || text.trim().isEmpty()) return false;
        try {
            if (outWav.exists() && outWav.length() > 44) return true;    // 已有缓存
            File parent = outWav.getParentFile();
            if (parent != null && !parent.exists()) parent.mkdirs();

            String say = numbersToChinese(text.trim());
            long t0 = System.currentTimeMillis();
            GeneratedAudio audio = tts.generateWithConfig(say,
                    new GenerationConfig(1.0f, 1.0f, 0, refAudio, refRate, refText, NUM_STEPS,
                            new HashMap<String, String>()));
            if (audio == null) { Log.w(TAG, "no audio"); return false; }
            boolean ok = audio.save(outWav.getAbsolutePath());
            Log.i(TAG, "speak ok=" + ok + "  " + (System.currentTimeMillis() - t0) + "ms  "
                    + audio.getSamples().length + " samples  -> " + outWav.getName());
            return ok;
        } catch (Throwable t) {
            Log.e(TAG, "speak failed", t);
            return false;
        }
    }

    public static void release() {
        try { if (tts != null) tts.release(); } catch (Throwable t) { /* ignore */ }
        tts = null;
        tried = false;
    }

    // ── 读参考音频（16bit PCM wav）────────────────────────────

    private static void readWav(File f) throws Exception {
        byte[] b = new byte[(int) f.length()];
        FileInputStream in = new FileInputStream(f);
        int got = 0;
        while (got < b.length) {
            int n = in.read(b, got, b.length - got);
            if (n <= 0) break;
            got += n;
        }
        in.close();
        int pos = 12, channels = 1, sampleRate = 24000, bits = 16, dataOff = -1, dataLen = 0;
        while (pos + 8 <= got) {
            String id = new String(b, pos, 4, "US-ASCII");
            int size = (b[pos + 4] & 0xff) | ((b[pos + 5] & 0xff) << 8) | ((b[pos + 6] & 0xff) << 16) | ((b[pos + 7] & 0xff) << 24);
            if (id.equals("fmt ")) {
                channels = (b[pos + 10] & 0xff) | ((b[pos + 11] & 0xff) << 8);
                sampleRate = (b[pos + 12] & 0xff) | ((b[pos + 13] & 0xff) << 8) | ((b[pos + 14] & 0xff) << 16) | ((b[pos + 15] & 0xff) << 24);
                bits = (b[pos + 22] & 0xff) | ((b[pos + 23] & 0xff) << 8);
            } else if (id.equals("data")) { dataOff = pos + 8; dataLen = size; }
            pos += 8 + size + (size % 2);
        }
        if (dataOff < 0 || bits != 16) throw new Exception("unsupported wav: bits=" + bits);
        int frames = dataLen / 2 / channels;
        float[] out = new float[frames];
        for (int i = 0; i < frames; i++) {
            int idx = dataOff + i * 2 * channels;
            short s = (short) ((b[idx] & 0xff) | (b[idx + 1] << 8));
            out[i] = s / 32768.0f;
        }
        refAudio = out;
        refRate = sampleRate;
    }

    private static String readText(File f) throws Exception {
        byte[] b = new byte[(int) f.length()];
        FileInputStream in = new FileInputStream(f);
        int got = in.read(b);
        in.close();
        return new String(b, 0, Math.max(got, 0), "UTF-8");
    }

    // ── 阿拉伯数字转中文（espeak 会把数字当 OOV 丢掉）──────────

    private static final String[] DIGITS = { "零", "一", "二", "三", "四", "五", "六", "七", "八", "九" };

    static String numbersToChinese(String s) {
        StringBuilder sb = new StringBuilder();
        int i = 0;
        while (i < s.length()) {
            char c = s.charAt(i);
            if (c >= '0' && c <= '9') {
                int j = i;
                while (j < s.length() && ((s.charAt(j) >= '0' && s.charAt(j) <= '9') || s.charAt(j) == '.')) j++;
                String num = s.substring(i, j);
                sb.append(numToChinese(num));
                i = j;
            } else {
                sb.append(c);
                i++;
            }
        }
        return sb.toString();
    }

    private static String numToChinese(String num) {
        int dot = num.indexOf('.');
        if (dot >= 0) {
            String intPart = numToChinese(num.substring(0, dot));
            StringBuilder frac = new StringBuilder();
            for (int k = dot + 1; k < num.length(); k++) {
                char d = num.charAt(k);
                if (d >= '0' && d <= '9') frac.append(DIGITS[d - '0']);
            }
            return intPart + "点" + frac;
        }
        long v;
        try { v = Long.parseLong(num); } catch (Exception e) { return num; }
        if (v == 0) return "零";
        if (v > 999999999999L) {                       // 太长（如手机号）→ 逐位念
            StringBuilder sb = new StringBuilder();
            for (int k = 0; k < num.length(); k++) sb.append(DIGITS[num.charAt(k) - '0']);
            return sb.toString();
        }
        String[] units = { "", "十", "百", "千", "万", "十", "百", "千", "亿" };
        StringBuilder out = new StringBuilder();
        String digits = String.valueOf(v);
        int len = digits.length();
        boolean lastZero = false;
        for (int k = 0; k < len; k++) {
            int d = digits.charAt(k) - '0';
            int unitPos = len - 1 - k;
            if (d == 0) { lastZero = true; continue; }
            if (lastZero && out.length() > 0) out.append("零");
            lastZero = false;
            out.append(DIGITS[d]).append(units[unitPos]);
        }
        String r = out.toString();
        if (r.startsWith("一十")) r = r.substring(1);   // 十五 而不是 一十五
        return r;
    }
}
