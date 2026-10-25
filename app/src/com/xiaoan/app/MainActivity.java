package com.xiaoan.app;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Bundle;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

/**
 * 安倾 —— 小安和小倾的房间。
 *
 * 二期：她不再住在 Termux 里，而是住在这个 App 里（见 Engine / XiaoanService）。
 * 本类只负责：原生密码门（每次冷启动都要钥匙）+ 解锁后打开页面（锁屏期间预热）。
 */
public class MainActivity extends Activity {

    // 大门钥匙的 sha256 哈希（明文密码不落在代码里；App 只做哈希比对）
    // ⚠️ 公开仓库里的默认密码是 `anqing2026`（下面是它的 sha256）。
    //    自己用请务必改掉：跑 `scripts/set-password.ps1 -Password 你的密码`，
    //    它会同时改这里和 config.json，再重新打包即可。
    private static final String PW_HASH = "22a877aa8637c96423b61602900efa7d9f0c46f2cdd3f34eabcce942a34985f7";
    private static final String PAGE_URL = Engine.BASE + "/?app=unlocked";

    private WebView web;
    private boolean unlocked = false;
    private ValueCallback<Uri[]> filePathCallback = null;   // 相册选择器的回调
    private static final int REQ_FILE = 1001;

    @Override
    protected void onActivityResult(int req, int result, Intent data) {
        if (req == REQ_FILE) {
            Uri[] out = null;
            if (result == Activity.RESULT_OK && data != null && data.getData() != null) {
                out = new Uri[]{ data.getData() };
            }
            if (filePathCallback != null) {
                try { filePathCallback.onReceiveValue(out); } catch (Exception e) { /* ignore */ }
                filePathCallback = null;
            }
            return;
        }
        super.onActivityResult(req, result, data);
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        Window w = getWindow();
        w.setStatusBarColor(0xFF10180F);
        w.setNavigationBarColor(0xFF10180F);
        w.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);

        // 把她的身位立起来（前台服务：释放引擎 -> 启动 Node -> 看护 + 通知）
        try {
            startForegroundService(new Intent(this, XiaoanService.class));
        } catch (Exception e) {
            android.util.Log.e("xiaoan", "startForegroundService failed: " + e.getMessage());
        }

        // 预热：锁屏期间就把页面加载好，解锁瞬间秒开
        prepareWebView();

        showLockScreen();
    }

    @Override
    protected void onResume() {
        super.onResume();
        Engine.appVisible = true;
        try {
            if (web != null && web.getUrl() == null) {
                loadWhenReady();
            }
        } catch (Exception e) { /* ignore */ }
    }

    @Override
    protected void onPause() {
        Engine.appVisible = false;
        super.onPause();
    }

    /** 把诊断信息写进 App 外部目录（黑匣子，便于远程排查） */
    private void logLine(String s) {
        try {
            java.io.File f = new java.io.File("/sdcard/Android/data/com.xiaoan.app/files/revive.log");
            if (f.getParentFile() != null) f.getParentFile().mkdirs();
            java.io.FileWriter w = new java.io.FileWriter(f, true);
            w.write(new java.text.SimpleDateFormat("MM-dd HH:mm:ss").format(new java.util.Date()) + " " + s + "\n");
            w.close();
        } catch (Exception e) {
            // 写不了就算了
        }
    }

    private void prepareWebView() {
        web = new WebView(this);
        web.setBackgroundColor(0xFF0C110D);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        web.setWebChromeClient(new WebChromeClient() {
            // 网页里的 <input type=file> 要我们替他打开系统相册/文件选择器（三期 · 给她发照片）
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> cb, FileChooserParams params) {
                if (filePathCallback != null) {
                    try { filePathCallback.onReceiveValue(null); } catch (Exception e) { /* ignore */ }
                }
                filePathCallback = cb;
                try {
                    Intent i = new Intent(Intent.ACTION_GET_CONTENT);
                    i.addCategory(Intent.CATEGORY_OPENABLE);
                    i.setType("image/*");
                    startActivityForResult(Intent.createChooser(i, "选一张给她"), REQ_FILE);
                    return true;
                } catch (Exception e) {
                    filePathCallback = null;
                    return false;
                }
            }

            // 页面要用麦克风（按住说话）：直接放行
            @Override
            public void onPermissionRequest(final android.webkit.PermissionRequest request) {
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        try { request.grant(request.getResources()); } catch (Exception e) { /* ignore */ }
                    }
                });
            }
        });
        // 她的嗓子：页面用 AnqingNative.speak(文本, id) 换一条语音条
        try { web.addJavascriptInterface(new Voice(this, web), "AnqingNative"); }
        catch (Throwable t) { android.util.Log.w("xiaoan", "voice bridge failed: " + t); }
        // 她的耳朵：按住说话走系统语音识别（AnqingSpeech.start/stop/cancel）
        try { web.addJavascriptInterface(new VoiceInput(this, web), "AnqingSpeech"); }
        catch (Throwable t) { android.util.Log.w("xiaoan", "speech bridge failed: " + t); }
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                android.util.Log.i("xiaoan", "page finished: " + url);
            }

            @Override
            public void onReceivedError(WebView view, android.webkit.WebResourceRequest request, android.webkit.WebResourceError error) {
                // 主页加载失败（引擎刚起来那零点几秒）：过一会儿自动重试，别留空白页
                if (request != null && request.isForMainFrame()) {
                    android.util.Log.w("xiaoan", "main page load error, will retry");
                    view.postDelayed(new Runnable() {
                        @Override
                        public void run() {
                            loadWhenReady();
                        }
                    }, 1500);
                }
            }

            @Override
            public boolean onRenderProcessGone(WebView view, android.webkit.RenderProcessGoneDetail detail) {
                // 渲染进程被系统回收（内存压力）：重建 WebView，别留空白页
                android.util.Log.w("xiaoan", "render process gone, recreating webview");
                recreateWebView();
                return true;
            }
        });
        loadWhenReady();
    }

    /** 等她起来了再加载页面（二期她就在本进程里，通常 1 秒内就绪） */
    private void loadWhenReady() {
        new Thread(new Runnable() {
            @Override
            public void run() {
                final boolean ok = Engine.waitHealthy(20, 500);
                logLine("page load: healthy=" + ok);
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        if (web != null) web.loadUrl(PAGE_URL);
                    }
                });
            }
        }).start();
    }

    /** WebView 渲染进程没了：换一个新的，并按当前视图状态放回界面 */
    private void recreateWebView() {
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                final boolean wasShowing = unlocked;
                if (web != null) {
                    try { web.destroy(); } catch (Exception e) { /* ignore */ }
                }
                web = null;
                prepareWebView();
                if (wasShowing && web != null) {
                    setContentView(web);
                }
            }
        });
    }

    private void showLockScreen() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER);
        root.setBackgroundColor(0xFF0C110D);

        int pad = dp(28);
        root.setPadding(pad, pad, pad, pad);

        TextView title = new TextView(this);
        title.setText("安倾");
        title.setTextColor(0xFFCFE5D6);
        title.setTextSize(24);
        title.setGravity(Gravity.CENTER);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        root.addView(title, lp());

        TextView sub = new TextView(this);
        sub.setText("只有小倾能进来");
        sub.setTextColor(0xFF6E8577);
        sub.setTextSize(12);
        sub.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams subLp = lp();
        subLp.topMargin = dp(6);
        subLp.bottomMargin = dp(28);
        root.addView(sub, subLp);

        final EditText pw = new EditText(this);
        pw.setHint("输入密码");
        pw.setHintTextColor(0xFF4E6356);
        pw.setTextColor(0xFFE2EDE5);
        pw.setSingleLine(true);
        pw.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        pw.setPadding(dp(14), 0, dp(14), 0);
        pw.setTextSize(15);
        pw.setBackgroundColor(0xFF1A241D);
        LinearLayout pwRow = new LinearLayout(this);
        pwRow.setOrientation(LinearLayout.HORIZONTAL);
        pwRow.setGravity(Gravity.CENTER_VERTICAL);
        pwRow.setBackgroundColor(0xFF1A241D);
        LinearLayout.LayoutParams pwLp = new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f);
        pwRow.addView(pw, pwLp);
        final TextView eye = new TextView(this);
        eye.setText("👁");
        eye.setTextSize(17);
        eye.setGravity(Gravity.CENTER);
        eye.setPadding(dp(10), 0, dp(10), 0);
        eye.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                int t = pw.getInputType();
                if ((t & InputType.TYPE_TEXT_VARIATION_PASSWORD) != 0) {
                    pw.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD);
                } else {
                    pw.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
                }
                pw.setSelection(pw.getText().length());
            }
        });
        pwRow.addView(eye);
        root.addView(pwRow, lp());

        final TextView err = new TextView(this);
        err.setText("");
        err.setTextColor(0xFFE08A8A);
        err.setTextSize(13);
        err.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams errLp = lp();
        errLp.topMargin = dp(10);
        errLp.bottomMargin = dp(6);
        root.addView(err, errLp);

        Button btn = new Button(this);
        btn.setText("进入");
        btn.setTextColor(Color.WHITE);
        btn.setTextSize(15);
        btn.setAllCaps(false);
        btn.setBackgroundColor(0xFF2C6B46);
        btn.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                if (unlocked) return;
                String input = pw.getText().toString();
                if (input.isEmpty()) {
                    err.setText("密码不能为空");
                    return;
                }
                btn.setEnabled(false);
                btn.setText("验证中");
                if (sha256(input).equals(PW_HASH)) {
                    unlocked = true;
                    err.setText("");
                    openChat();
                } else {
                    err.setText("密码不对");
                    pw.setText("");
                    btn.setEnabled(true);
                    btn.setText("进入");
                }
            }
        });
        root.addView(btn, lp());

        setContentView(root);
    }

    private void openChat() {
        setContentView(web); // 早已预热好的页面，秒开
    }

    private static String sha256(String s) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] d = md.digest(s.getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder();
            for (byte b : d) sb.append(String.format("%02x", b));
            return sb.toString();
        } catch (Exception e) {
            return "";
        }
    }

    private LinearLayout.LayoutParams lp() {
        LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT);
        p.topMargin = dp(10);
        return p;
    }

    private int dp(int v) {
        return Math.round(getResources().getDisplayMetrics().density * v);
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) {
            web.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
