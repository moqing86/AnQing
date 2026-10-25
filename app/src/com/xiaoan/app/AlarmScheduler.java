package com.xiaoan.app;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

/**
 * 探针用闹钟（二期遗留问题：ColorOS 后台冻结）。
 *
 * 单次闹钟 + 每响一次重排下一次：
 *   * setAndAllowWhileIdle 不需要"精确闹钟"权限，且在待机/冻结状态下也会被投递
 *   * setInexactRepeating 的最小周期在 API 19+ 被系统拉长，单次重排更可控
 *
 * 这一步只回答一个问题：被 OplusHansManager 冻结的进程，能不能被闹钟叫醒。
 */
public final class AlarmScheduler {

    private static final String TAG = "XIAOAN-ALARM";
    public static final long INTERVAL_MS = 2 * 60 * 1000L;   // 探针期：2 分钟一次
    public static final long FIRST_MS = 60 * 1000L;          // 首次 1 分钟后（先验证机制本身通不通）
    private static final int REQ = 2001;

    private AlarmScheduler() { }

    private static PendingIntent pending(Context ctx) {
        Intent i = new Intent(ctx, AlarmTick.class).setAction("com.xiaoan.app.ALARM_TICK");
        return PendingIntent.getBroadcast(ctx, REQ, i,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /** 精确闹钟能不能用（Android 12+ 需要 SCHEDULE_EXACT_ALARM 授权） */
    public static boolean exactAllowed(Context ctx) {
        try {
            if (android.os.Build.VERSION.SDK_INT < 31) return true;
            AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
            return am != null && am.canScheduleExactAlarms();
        } catch (Throwable t) {
            return false;
        }
    }

    public static void schedule(Context ctx) { schedule(ctx, INTERVAL_MS); }

    public static void schedule(Context ctx, long delayMs) {
        try {
            AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
            if (am == null) { Log.w(TAG, "no AlarmManager"); return; }
            long at = System.currentTimeMillis() + delayMs;
            PendingIntent pi = pending(ctx);
            // 探针第二轮：先试精确闹钟（系统会在待机/冻结下也准时投递），不行再退回非精确
            if (exactAllowed(ctx)) {
                try {
                    am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
                    Log.i(TAG, "EXACT tick in " + (delayMs / 1000) + "s (at " + at + ")");
                    return;
                } catch (SecurityException se) {
                    Log.w(TAG, "exact alarm refused: " + se.getMessage());
                }
            }
            am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
            Log.i(TAG, "INEXACT tick in " + (delayMs / 1000) + "s (at " + at + ")");
        } catch (Exception e) {
            Log.w(TAG, "schedule failed: " + e);
        }
    }

    public static void cancel(Context ctx) {
        try {
            AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
            if (am != null) am.cancel(pending(ctx));
        } catch (Exception e) { /* ignore */ }
    }
}
