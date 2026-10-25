package com.xiaoan.app;

import android.content.Context;
import android.util.Log;

import com.janeasystems.rn_nodejs_mobile.RNNodeJsMobileModule;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Scanner;

/**
 * 她的引擎。
 *
 * 二期架构的核心：不再依赖 Termux —— 把 server.js 和她的心文件释放到 App 内部存储，
 * 然后用内嵌的 Node（libnode.so）在 App 进程里把服务跑起来。
 *
 * 关键点：
 *   * 释放规则：代码/心文件母本每次覆盖（升级即生效）；data/ 与 memory.txt 只在缺失时播种（她的记忆永不覆盖）
 *   * 绝不起第二个 Node：nodeThread 活着就什么都不做（同名进程里起两个 Node 会抢端口、还会分裂成两个她）
 */
public final class Engine {

    public static final int PORT = 3083;
    public static final String BASE = "http://127.0.0.1:" + PORT;
    public static final String CID = "xiaoan";

    private static final String TAG = "XIAOAN-ENGINE";

    private static volatile Thread nodeThread = null;
    private static volatile boolean nodeLibLoaded = false;
    private static volatile boolean shimLibLoaded = false;

    /** 页面是否在前台（前台时不发系统通知，免得刷屏） */
    public static volatile boolean appVisible = false;

    private Engine() { }

    public static File engineDir(Context ctx) {
        return new File(ctx.getFilesDir(), "engine");
    }

    public static File ttsDir(Context ctx) {
        return new File(engineDir(ctx), "tts");
    }

    /** 她的耳朵的模型目录（离线语音识别 SenseVoice） */
    public static File asrDir(Context ctx) {
        return new File(engineDir(ctx), "asr");
    }

    /**
     * 离线识别模型（SenseVoice int8，227 MB）也打成 zip 放 assets，首次用到才解压。
     * 这台手机没有系统语音识别服务（实测 pm query-services 查不到），所以必须自带模型。
     */
    public static synchronized void ensureAsr(Context ctx) throws IOException {
        File dir = asrDir(ctx);
        File marker = new File(dir, "model.int8.onnx");
        if (marker.exists() && marker.length() > 1000000) return;   // 已解压
        if (!dir.exists() && !dir.mkdirs()) throw new IOException("cannot create " + dir);
        long t0 = System.currentTimeMillis();
        InputStream in = null;
        java.util.zip.ZipInputStream zin = null;
        try {
            in = ctx.getAssets().open("asr/asr.zip");
            zin = new java.util.zip.ZipInputStream(in);
            byte[] buf = new byte[65536];
            java.util.zip.ZipEntry e;
            while ((e = zin.getNextEntry()) != null) {
                File out = new File(dir, e.getName());
                if (e.isDirectory()) { out.mkdirs(); zin.closeEntry(); continue; }
                File parent = out.getParentFile();
                if (parent != null && !parent.exists()) parent.mkdirs();
                FileOutputStream fos = new FileOutputStream(out);
                int n;
                while ((n = zin.read(buf)) > 0) fos.write(buf, 0, n);
                fos.close();
                zin.closeEntry();
            }
        } finally {
            if (zin != null) { try { zin.close(); } catch (IOException ignored) { } }
            if (in != null) { try { in.close(); } catch (IOException ignored) { } }
        }
        Log.i(TAG, "asr model extracted in " + (System.currentTimeMillis() - t0) + "ms -> " + dir);
    }

    /**
     * 语音模型（ZipVoice 克隆，195 MB）单独打成一个 zip 放 assets，首次启动解压。
     * 比逐个文件走 aapt add 快得多，也避免 100+ 个资产条目。
     */
    public static synchronized void ensureTts(Context ctx) throws IOException {
        File dir = ttsDir(ctx);
        File marker = new File(dir, "decoder.int8.onnx");
        if (marker.exists() && marker.length() > 1000000) return;   // 已解压
        if (!dir.exists() && !dir.mkdirs()) throw new IOException("cannot create " + dir);
        long t0 = System.currentTimeMillis();
        InputStream in = null;
        java.util.zip.ZipInputStream zin = null;
        try {
            in = ctx.getAssets().open("tts/tts.zip");
            zin = new java.util.zip.ZipInputStream(in);
            byte[] buf = new byte[65536];
            java.util.zip.ZipEntry e;
            while ((e = zin.getNextEntry()) != null) {
                File out = new File(dir, e.getName());
                if (e.isDirectory()) { out.mkdirs(); zin.closeEntry(); continue; }
                File parent = out.getParentFile();
                if (parent != null && !parent.exists()) parent.mkdirs();
                FileOutputStream fos = new FileOutputStream(out);
                int n;
                while ((n = zin.read(buf)) > 0) fos.write(buf, 0, n);
                fos.close();
                zin.closeEntry();
            }
        } finally {
            if (zin != null) { try { zin.close(); } catch (IOException ignored) { } }
            if (in != null) { try { in.close(); } catch (IOException ignored) { } }
        }
        Log.i(TAG, "tts models extracted in " + (System.currentTimeMillis() - t0) + "ms -> " + dir);
    }

    // ── 资产释放 ─────────────────────────────────────────────

    public static void ensureAssets(Context ctx) throws IOException {
        File root = engineDir(ctx);
        if (!root.exists() && !root.mkdirs()) throw new IOException("cannot create " + root);
        copyAsset(ctx, "engine", root, root);
    }

    private static void copyAsset(Context ctx, String assetPath, File dest, File root) throws IOException {
        String[] children = ctx.getAssets().list(assetPath);
        if (children == null || children.length == 0) {
            copyAssetFile(ctx, assetPath, dest, root);
            return;
        }
        if (!dest.exists() && !dest.mkdirs()) throw new IOException("cannot mkdir " + dest);
        for (String name : children) {
            copyAsset(ctx, assetPath + "/" + name, new File(dest, name), root);
        }
    }

    private static void copyAssetFile(Context ctx, String assetPath, File dest, File root) throws IOException {
        String rel = dest.getAbsolutePath().substring(root.getAbsolutePath().length() + 1).replace('\\', '/');
        boolean isStateFile = rel.startsWith("data/") || dest.getName().equals("memory.txt");
        if (isStateFile && dest.exists()) {
            return; // 她的记忆：只在第一次播种，之后只属于她
        }
        // 开发模式：热更新推过来的代码，别用 APK 里的旧版本盖掉（标记会自动过期，不留后门）
        if (!isStateFile && dest.exists() && devMarkFresh(root)) {
            Log.i(TAG, "dev mode: keep hot-reloaded " + rel);
            return;
        }
        File parent = dest.getParentFile();
        if (parent != null && !parent.exists()) parent.mkdirs();
        InputStream in = ctx.getAssets().open(assetPath);
        OutputStream out = new FileOutputStream(dest);
        byte[] buf = new byte[65536];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        out.flush();
        out.close();
        in.close();
    }

    /** filesDir/engine/.dev 里存着上次热更新的时间戳；2 小时内算"正在开发" */
    private static final long DEV_TTL_MS = 2 * 3600 * 1000L;

    private static boolean devMarkFresh(File root) {
        try {
            File m = new File(root, ".dev");
            if (!m.exists()) return false;
            long len = m.length();
            if (len <= 0 || len > 32) return false;
            byte[] buf = new byte[(int) len];
            java.io.FileInputStream in = new java.io.FileInputStream(m);
            int read = in.read(buf);
            in.close();
            if (read <= 0) return false;
            long ts = Long.parseLong(new String(buf, 0, read, "UTF-8").trim());
            return System.currentTimeMillis() - ts < DEV_TTL_MS;
        } catch (Exception e) {
            return false;
        }
    }

    // ── Node 启停 ────────────────────────────────────────────

    public static boolean isNodeAlive() {
        Thread t = nodeThread;
        return t != null && t.isAlive();
    }

    /** 启动引擎（幂等；已在跑就直接返回）。必须在后台线程里被调用，Node 会吃掉调用线程。 */
    public static synchronized void startNode(final Context ctx) {
        if (isNodeAlive()) {
            Log.i(TAG, "node already alive, skip start");
            return;
        }
        final File root = engineDir(ctx);
        final File server = new File(root, "server.js");
        if (!server.exists()) {
            Log.e(TAG, "server.js missing at " + server);
            return;
        }
        Thread t = new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    if (!shimLibLoaded) {
                        System.loadLibrary("xiaoan_node"); // 会连带把 libnode.so / libc++_shared.so 拉进来
                        shimLibLoaded = true;
                        Log.i(TAG, "libxiaoan_node.so loaded");
                    }
                    if (!nodeLibLoaded) {
                        nodeLibLoaded = true; // loadLibrary("node") 已由依赖链完成，这里只记状态
                    }
                    Log.i(TAG, "starting node: " + server.getAbsolutePath());
                    int code = RNNodeJsMobileModule.startNodeWithArguments(
                            new String[] { "node", server.getAbsolutePath() },
                            new File(root, "node_modules").getAbsolutePath(),
                            true);
                    Log.w(TAG, "node exited with code " + code);
                } catch (Throwable e) {
                    Log.e(TAG, "node start FAILED: " + e, e);
                }
            }
        }, "xiaoan-node");
        nodeThread = t;
        t.start();
    }

    // ── HTTP ─────────────────────────────────────────────────

    public static String get(String path, int timeoutMs) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(BASE + path).openConnection();
            c.setConnectTimeout(timeoutMs);
            c.setReadTimeout(timeoutMs);
            if (c.getResponseCode() != 200) return null;
            InputStream in = c.getInputStream();
            Scanner s = new Scanner(in, "UTF-8").useDelimiter("\\A");
            return s.hasNext() ? s.next() : "";
        } catch (Exception e) {
            return null;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    public static boolean health() {
        return get("/api/health", 1500) != null;
    }

    /** 等她起来（Node 冷启动约 1 秒内），返回是否成功 */
    public static boolean waitHealthy(int tries, int gapMs) {
        for (int i = 0; i < tries; i++) {
            if (health()) return true;
            try { Thread.sleep(gapMs); } catch (InterruptedException e) { return false; }
        }
        return false;
    }
}
