package com.xiaoan.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

/**
 * 闹钟接收器 —— 探针阶段只写日志，不做任何业务。
 *
 * 观测量：
 *   * 闹钟到底响没响（进程被冻结时，系统投递广播会不会把它解冻）
 *   * 解冻之后 Node 引擎还在不在、还答不答话（她能不能在这几秒里发消息）
 */
public class AlarmTick extends BroadcastReceiver {

    public static final String TAG = "XIAOAN-ALARM";

    @Override
    public void onReceive(Context ctx, Intent intent) {
        boolean answers = Engine.health();
        Log.i(TAG, "TICK t=" + System.currentTimeMillis()
                + " exact=" + AlarmScheduler.exactAllowed(ctx)
                + " nodeAlive=" + Engine.isNodeAlive()
                + " engineAnswers=" + answers);
        AlarmScheduler.schedule(ctx);   // 单次闹钟：响一次，排下一次
    }
}
