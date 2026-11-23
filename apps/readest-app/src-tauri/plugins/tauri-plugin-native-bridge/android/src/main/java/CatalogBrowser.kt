package com.readest.native_bridge

import android.app.Activity
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import app.tauri.annotation.InvokeArg
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import java.io.File
import java.net.SocketTimeoutException
import java.net.URL
import org.json.JSONObject

@InvokeArg
class CatalogPageArgs { lateinit var url: String }

@InvokeArg
class CatalogFileArgs {
    lateinit var url: String
    lateinit var path: String
    var referer: String? = null
    var remainingMs: Long = 0
}

internal object CatalogBrowser {
    private fun allowed(uri: Uri) = uri.scheme == "https" && uri.host == "zh.z-library.sk" &&
        uri.userInfo == null && (uri.port == -1 || uri.port == 443) &&
        (uri.path == "/" || uri.path?.startsWith("/book/") == true || uri.path?.startsWith("/s/") == true)

    /** A real WebView in the same Android profile as the visible book page. */
    fun read(activity: Activity, invoke: Invoke) {
        val url = invoke.parseArgs(CatalogPageArgs::class.java).url
        if (!allowed(Uri.parse(url))) { invoke.reject("Invalid catalog URL"); return }
        activity.runOnUiThread {
            if (activity.isFinishing || activity.isDestroyed) { invoke.reject("Catalog unavailable"); return@runOnUiThread }
            val view = WebView(activity)
            val handler = Handler(Looper.getMainLooper())
            var finished = false
            fun finish(page: JSONObject? = null, error: String? = null) {
                if (finished) return
                finished = true
                handler.removeCallbacksAndMessages(null)
                view.stopLoading()
                view.webViewClient = WebViewClient()
                view.destroy()
                if (page != null) {
                    invoke.resolve(JSObject().apply {
                        put("url", page.getString("url"))
                        put("html", page.getString("html"))
                    })
                } else invoke.reject(error ?: "Catalog page not recognized")
            }
            try {
                val script = activity.assets.open("readest-catalog-page.js").bufferedReader().use { it.readText() }
                BrowserSession.configure(view)
                view.settings.allowFileAccess = false
                view.settings.allowContentAccess = false
                view.webViewClient = object : WebViewClient() {
                    override fun shouldOverrideUrlLoading(v: WebView, request: WebResourceRequest): Boolean {
                        if (!request.isForMainFrame || allowed(request.url)) return false
                        handler.post { finish(error = "Catalog access required") }
                        return true
                    }
                    override fun onReceivedHttpError(v: WebView, request: WebResourceRequest, response: WebResourceResponse) {
                        if (request.isForMainFrame) handler.post { finish(error = "Catalog HTTP ${response.statusCode}") }
                    }
                    override fun onReceivedError(v: WebView, request: WebResourceRequest, error: WebResourceError) {
                        if (request.isForMainFrame) handler.post { finish(error = "Catalog network error") }
                    }
                    override fun onPageFinished(v: WebView, loaded: String) {
                        if (finished || loaded == "about:blank" || loaded != v.url) return
                        if (!allowed(Uri.parse(loaded))) { handler.post { finish(error = "Catalog access required") }; return }
                        v.evaluateJavascript(script.replace("__READEST_CATALOG_URL__", JSONObject.quote(url))) { value ->
                            if (finished) return@evaluateJavascript
                            val result = runCatching { JSONObject(value) }.getOrNull()
                            if (result != null && result.has("html") && result.has("url")) finish(page = result)
                            else finish(error = result?.optString("error", "Catalog page not recognized"))
                        }
                    }
                }
                handler.postDelayed({ finish(error = "Catalog page timed out") }, 30_000L)
                view.loadUrl(url)
            } catch (_: Exception) { finish(error = "Catalog browser unavailable") }
        }
    }

    fun downloadHop(activity: Activity, invoke: Invoke) {
        val args = invoke.parseArgs(CatalogFileArgs::class.java)
        Thread {
            try {
                val dest = File(args.path).canonicalFile
                if (!dest.toPath().startsWith(activity.cacheDir.canonicalFile.toPath()) ||
                    !dest.name.matches(Regex("catalog-[0-9a-f-]{36}\\.(epub|pdf|azw3|mobi|fb2|txt)")) ||
                    !dest.isFile || !args.url.startsWith("https://")) {
                    invoke.reject("Invalid catalog download")
                    return@Thread
                }
                val response = BrowserSession.downloadHop(
                    URL(args.url), BrowserSession.userAgent, args.referer, dest,
                    SystemClock.elapsedRealtime() + args.remainingMs,
                )
                invoke.resolve(JSObject().apply {
                    put("status", response.status)
                    response.location?.let { put("location", it) }
                })
            } catch (_: SocketTimeoutException) {
                invoke.reject("Catalog download timed out")
            } catch (e: Exception) {
                // A platform error can include a signed download URL. Only report known reasons.
                val known = setOf("Catalog returned a page", "Book exceeds device transfer limit", "Catalog download timed out")
                invoke.reject(e.message?.takeIf { it in known } ?: "Catalog file transfer failed")
            }
        }.start()
    }
}
