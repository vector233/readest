package com.readest.native_bridge

import android.os.SystemClock
import android.webkit.CookieManager
import android.webkit.WebView
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/** The in-app browser and its file transfers share the device's browser session. */
internal object BrowserSession {
    const val userAgent = ClipUrlController.BROWSER_USER_AGENT

    fun configure(view: WebView) {
        view.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            userAgentString = userAgent
        }
        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            setAcceptThirdPartyCookies(view, true)
        }
    }

    data class Response(val status: Int, val location: String?)

    /** One hop. The caller validates redirects before the next host receives a request. */
    fun downloadHop(
        url: URL, agent: String, referer: String?, dest: File, deadline: Long? = null,
    ): Response {
        val connection = url.openConnection() as HttpURLConnection
        try {
            connection.instanceFollowRedirects = false
            val remaining = deadline?.let { (it - SystemClock.elapsedRealtime()).coerceIn(1L, 600_000L).toInt() }
            connection.connectTimeout = minOf(15_000, remaining ?: 15_000)
            connection.readTimeout = minOf(60_000, remaining ?: 60_000)
            connection.setRequestProperty("User-Agent", agent)
            val cookies = CookieManager.getInstance()
            cookies.getCookie(url.toString())?.takeIf { it.isNotEmpty() }?.let {
                connection.setRequestProperty("Cookie", it)
            }
            if (referer != null && sameOrigin(URL(referer), url)) {
                connection.setRequestProperty("Referer", referer.substringBefore('#'))
            }
            val status = connection.responseCode
            for ((name, values) in connection.headerFields) {
                if (name.equals("Set-Cookie", ignoreCase = true)) {
                    values.forEach { cookies.setCookie(url.toString(), it) }
                }
            }
            if (status !in 200..299) return Response(status, connection.getHeaderField("Location"))
            if (deadline != null) {
                val mime = connection.contentType.orEmpty().lowercase()
                if (mime.contains("html") || mime.contains("json")) throw IOException("Catalog returned a page")
                if (connection.contentLengthLong > MAX_BOOK_BYTES) throw IOException("Book exceeds device transfer limit")
            }
            connection.inputStream.use { input ->
                dest.outputStream().buffered().use { output ->
                    val buffer = ByteArray(32 * 1024)
                    var total = 0L
                    while (true) {
                        val count = input.read(buffer)
                        if (count == -1) break
                        total += count
                        if (deadline != null) {
                            if (total > MAX_BOOK_BYTES) throw IOException("Book exceeds device transfer limit")
                            if (SystemClock.elapsedRealtime() >= deadline) throw IOException("Catalog download timed out")
                        }
                        output.write(buffer, 0, count)
                    }
                }
            }
            return Response(status, null)
        } finally {
            connection.disconnect()
        }
    }

    fun sameOrigin(a: URL, b: URL) =
        a.protocol.equals(b.protocol, true) && a.host.equals(b.host, true) &&
            (if (a.port == -1) a.defaultPort else a.port) == (if (b.port == -1) b.defaultPort else b.port)

    private const val MAX_BOOK_BYTES = 1024L * 1024 * 1024
}
