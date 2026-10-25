package com.janeasystems.rn_nodejs_mobile;

/**
 * libxiaoan_node.so（我们自己编的 JNI 胶水层）的影子类。
 *
 * 符号名由 JNI 规则决定：包名/类名里的下划线会被转义成 "_1"，所以这里必须叫
 * com.janeasystems.rn_nodejs_mobile.RNNodeJsMobileModule，方法必须叫 startNodeWithArguments，
 * 才能和 C++ 侧的 Java_com_janeasystems_rn_1nodejs_1mobile_RNNodeJsMobileModule_startNodeWithArguments 对上。
 */
public class RNNodeJsMobileModule {

    /** 在调用线程上启动 Node 并跑事件循环，直到进程结束才返回（永远阻塞，别放主线程）。 */
    public static native int startNodeWithArguments(String[] arguments, String modulesPath, boolean redirectOutputToLogcat);
}
