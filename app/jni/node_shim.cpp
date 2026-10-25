// 安倾 · Node 引擎的 JNI 胶水层
//
// 作用：把 nodejs-mobile 的 libnode.so（只导出 node::Start）接到 Java 上。
// 编译：NDK clang++（见 anqing/common/scripts/build-node-shim.ps1）
//   -> libxiaoan_node.so，DT_NEEDED 含 libnode.so / libc++_shared.so
//
// 与 nodejs-mobile 原版 native-lib.cpp 的差异：
//   * 只保留 startNodeWithArguments（不用它的 rn-bridge 通道）
//   * argv 仍然一次性分配在连续内存里（libuv 要求）
//   * 保留了 stdout/stderr -> logcat 的转发（日志白送，便于远程排查）

#include <jni.h>
#include <android/log.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

// libnode.so 导出的入口（符号 _ZN4node5StartEiPPc）
namespace node {
int Start(int argc, char* argv[]);
}

#define LOG_TAG "XIAOAN-NODE"

static int g_out[2];
static int g_err[2];

static void* pump_to_logcat(void* arg) {
    int fd = (int) (intptr_t) arg;
    char buf[2048];
    ssize_t n;
    while ((n = read(fd, buf, sizeof(buf) - 1)) > 0) {
        if (buf[n - 1] == '\n') --n;
        buf[n] = 0;
        __android_log_write(ANDROID_LOG_INFO, LOG_TAG, buf);
    }
    return NULL;
}

static void redirect_stdio_to_logcat(void) {
    setvbuf(stdout, NULL, _IONBF, 0);
    setvbuf(stderr, NULL, _IONBF, 0);
    if (pipe(g_out) != 0) return;
    if (pipe(g_err) != 0) return;
    dup2(g_out[1], STDOUT_FILENO);
    dup2(g_err[1], STDERR_FILENO);
    pthread_t t1, t2;
    if (pthread_create(&t1, NULL, pump_to_logcat, (void*) (intptr_t) g_out[0]) == 0) pthread_detach(t1);
    if (pthread_create(&t2, NULL, pump_to_logcat, (void*) (intptr_t) g_err[0]) == 0) pthread_detach(t2);
}

extern "C" JNIEXPORT jint JNICALL
Java_com_janeasystems_rn_1nodejs_1mobile_RNNodeJsMobileModule_startNodeWithArguments(
        JNIEnv* env,
        jclass clazz,
        jobjectArray jargs,
        jstring jmodulesPath,
        jboolean jredirect) {

    (void) clazz;

    if (jredirect) redirect_stdio_to_logcat();

    jsize count = env->GetArrayLength(jargs);

    // 1) 量一遍总长度，argv 必须落在同一块连续内存
    size_t total = 0;
    for (jsize i = 0; i < count; ++i) {
        jstring s = (jstring) env->GetObjectArrayElement(jargs, i);
        const char* c = env->GetStringUTFChars(s, NULL);
        total += strlen(c) + 1;
        env->ReleaseStringUTFChars(s, c);
        env->DeleteLocalRef(s);
    }

    char* buffer = (char*) calloc(total > 0 ? total : 1, 1);
    char** argv = (char**) calloc((size_t) count + 1, sizeof(char*));
    if (buffer == NULL || argv == NULL) {
        __android_log_write(ANDROID_LOG_ERROR, LOG_TAG, "out of memory building argv");
        return -1;
    }

    // 2) 灌进去
    char* cursor = buffer;
    for (jsize i = 0; i < count; ++i) {
        jstring s = (jstring) env->GetObjectArrayElement(jargs, i);
        const char* c = env->GetStringUTFChars(s, NULL);
        size_t len = strlen(c);
        memcpy(cursor, c, len);
        argv[i] = cursor;
        cursor += len + 1;
        env->ReleaseStringUTFChars(s, c);
        env->DeleteLocalRef(s);
    }
    argv[count] = NULL;

    // 3) NODE_PATH（我们的引擎零依赖，纯属保险）
    if (jmodulesPath != NULL) {
        const char* modules = env->GetStringUTFChars(jmodulesPath, NULL);
        setenv("NODE_PATH", modules, 1);
        env->ReleaseStringUTFChars(jmodulesPath, modules);
    }

    // 4) 关键：Node 会接管这个线程并跑事件循环，直到进程结束才返回
    __android_log_print(ANDROID_LOG_INFO, LOG_TAG, "node::Start ing (argc=%d, argv[1]=%s)",
                        (int) count, count > 1 ? argv[1] : "(none)");
    int code = node::Start((int) count, argv);
    __android_log_print(ANDROID_LOG_INFO, LOG_TAG, "node::Start returned %d", code);

    free(argv);
    free(buffer);
    return (jint) code;
}
