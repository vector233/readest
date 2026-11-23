package com.readest.native_bridge

import android.app.Activity
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.SystemClock
import android.provider.Settings
import androidx.core.content.FileProvider
import app.tauri.annotation.InvokeArg
import app.tauri.plugin.Channel
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicBoolean
import javax.net.ssl.HttpsURLConnection
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject

@InvokeArg
class PersonalUpdateArgs {
    var versionCode: Int = 0
    var onProgress: Channel? = null
}

internal class PersonalUpdater(private val activity: Activity) {
    companion object {
        private const val PACKAGE = "com.bilingify.readest.personal"
        private const val REPOSITORY = "vector233/readest"
        private const val TAG = "android-personal"
        private const val MAX_APK_SIZE = 512L * 1024 * 1024
        private val assetName = Regex("""Readest-([1-9]\d{0,9})-(\d+\.\d+\.\d+-personal\.\d+)-arm64\.apk""")
        private val digestPattern = Regex("sha256:[a-f0-9]{64}")
        private val assetHosts = setOf("github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com")
    }

    private data class Release(
        val fileName: String,
        val code: Long,
        val version: String,
        val size: Long,
        val digest: String,
    )

    private class InvalidUpdate : IOException()
    private val installing = AtomicBoolean()
    @Volatile private var candidate: Release? = null
    private val manager get() = activity.packageManager

    @Suppress("DEPRECATION")
    private val signatureFlags get() =
        if (Build.VERSION.SDK_INT >= 28) PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES

    @Suppress("DEPRECATION")
    private fun PackageInfo.code() = if (Build.VERSION.SDK_INT >= 28) longVersionCode else versionCode.toLong()

    @Suppress("DEPRECATION")
    private fun PackageInfo.signers() =
        if (Build.VERSION.SDK_INT >= 28) signingInfo?.apkContentsSigners.orEmpty().toSet()
        else signatures.orEmpty().toSet()

    @Suppress("DEPRECATION")
    private fun installed(): PackageInfo {
        check(activity.packageName == PACKAGE)
        return manager.getPackageInfo(PACKAGE, signatureFlags)
    }

    suspend fun check(invoke: Invoke) {
        try {
            val result = withContext(Dispatchers.IO) {
                val installed = installed()
                val release = findRelease(installed.code())
                candidate = release
                JSObject().apply {
                    put("currentVersion", installed.versionName)
                    if (release != null) put("release", JSObject().apply {
                        put("versionCode", release.code)
                        put("versionName", release.version)
                        put("size", release.size)
                    })
                }
            }
            invoke.resolve(result)
        } catch (_: Exception) {
            invoke.reject("update-check-failed")
        }
    }

    suspend fun install(invoke: Invoke) {
        val args = invoke.parseArgs(PersonalUpdateArgs::class.java)
        val release = candidate
        if (release == null || release.code != args.versionCode.toLong() ||
            activity.packageName != PACKAGE || !installing.compareAndSet(false, true)) {
            invoke.reject("update-unavailable")
            return
        }
        try {
            if (!manager.canRequestPackageInstalls()) {
                activity.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:$PACKAGE")))
                invoke.resolveObject("permission")
                return
            }
            val file = withContext(Dispatchers.IO) { prepareApk(release, args.onProgress) }
            val uri = FileProvider.getUriForFile(activity, "$PACKAGE.fileprovider", file)
            val intent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, "application/vnd.android.package-archive")
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            activity.startActivity(intent)
            invoke.resolveObject("installer")
        } catch (_: InvalidUpdate) {
            invoke.reject("invalid-update-package")
        } catch (_: Exception) {
            invoke.reject("update-install-failed")
        } finally {
            installing.set(false)
        }
    }

    private fun findRelease(currentCode: Long): Release? {
        val url = URL("https://api.github.com/repos/$REPOSITORY/releases/tags/$TAG")
        val json = request(url, setOf("api.github.com"), "application/vnd.github+json") { connection ->
            val out = ByteArrayOutputStream()
            transfer(connection, 2 * 1024 * 1024L, 30_000) { bytes, length, _ ->
                out.write(bytes, 0, length)
            }
            JSONObject(out.toString("UTF-8"))
        }
        check(!json.getBoolean("draft") && json.getString("tag_name") == TAG)
        val assets = json.getJSONArray("assets")
        var newest: Release? = null
        for (index in 0 until assets.length()) {
            val asset = assets.getJSONObject(index)
            if (asset.optString("state") != "uploaded") continue
            val name = asset.optString("name")
            val match = assetName.matchEntire(name) ?: continue
            val code = match.groupValues[1].toLong()
            if (code <= (newest?.code ?: currentCode) || code > Int.MAX_VALUE) continue
            newest = Release(name, code, match.groupValues[2], asset.optLong("size"), asset.optString("digest"))
        }
        if (newest != null && (newest.size !in 1..MAX_APK_SIZE || !digestPattern.matches(newest.digest))) {
            throw InvalidUpdate()
        }
        return newest
    }

    private fun prepareApk(release: Release, progress: Channel?): File {
        val installed = installed()
        if (release.code <= installed.code()) throw InvalidUpdate()
        val cached = File(activity.cacheDir, "readest-personal-update.apk")
        if (cached.length() == release.size && sha256(cached) == release.digest) {
            verifyArchive(cached, installed, release)
            return cached
        }
        activity.cacheDir.listFiles { f -> f.name.startsWith("readest-personal-part-") }?.forEach { it.delete() }
        val temp = File.createTempFile("readest-personal-part-", ".apk", activity.cacheDir)
        try {
            val url = URL("https://github.com/$REPOSITORY/releases/download/$TAG/${release.fileName}")
            val digest = MessageDigest.getInstance("SHA-256")
            var lastPercent = 0
            val length = request(url, assetHosts, "application/octet-stream") { connection ->
                temp.outputStream().buffered().use { output ->
                    transfer(connection, release.size, 8 * 60_000L) { bytes, size, received ->
                        digest.update(bytes, 0, size)
                        output.write(bytes, 0, size)
                        val percent = (100 * received / release.size).toInt()
                        if (percent > lastPercent) {
                            progress?.sendObject(percent)
                            lastPercent = percent
                        }
                    }
                }
            }
            if (length != release.size || digestText(digest) != release.digest) throw InvalidUpdate()
            verifyArchive(temp, installed, release)
            if (!temp.renameTo(cached)) throw IOException("Could not save the update")
            return cached
        } finally {
            temp.delete()
        }
    }

    @Suppress("DEPRECATION")
    private fun verifyArchive(file: File, installed: PackageInfo, release: Release) {
        val archive = manager.getPackageArchiveInfo(file.absolutePath, signatureFlags) ?: throw InvalidUpdate()
        val signers = installed.signers()
        if (archive.packageName != PACKAGE || archive.code() != release.code || archive.versionName != release.version ||
            signers.isEmpty() || archive.signers() != signers) throw InvalidUpdate()
    }

    private fun sha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { stream ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
                val size = stream.read(buffer)
                if (size < 0) break
                digest.update(buffer, 0, size)
            }
        }
        return digestText(digest)
    }

    private fun digestText(digest: MessageDigest) = "sha256:" + digest.digest().joinToString("") { "%02x".format(it) }

    private fun <T> request(start: URL, hosts: Set<String>, accept: String, consume: (HttpsURLConnection) -> T): T {
        var url = start
        repeat(5) {
            if (url.protocol != "https" || url.host !in hosts || url.userInfo != null ||
                (url.port != -1 && url.port != 443)) throw IOException("Invalid release URL")
            val connection = url.openConnection() as HttpsURLConnection
            try {
                connection.instanceFollowRedirects = false
                connection.connectTimeout = 15_000
                connection.readTimeout = 20_000
                connection.useCaches = false
                connection.setRequestProperty("Accept", accept)
                connection.setRequestProperty("User-Agent", "Readest-Personal-Android")
                when (connection.responseCode) {
                    200 -> return consume(connection)
                    301, 302, 303, 307, 308 -> {
                        val location = connection.getHeaderField("Location") ?: throw IOException("Missing redirect")
                        url = URL(url, location)
                    }
                    else -> throw IOException("Release unavailable")
                }
            } finally {
                connection.disconnect()
            }
        }
        throw IOException("Too many release redirects")
    }

    private fun transfer(
        connection: HttpsURLConnection,
        limit: Long,
        timeout: Long,
        write: (ByteArray, Int, Long) -> Unit,
    ): Long {
        val deadline = SystemClock.elapsedRealtime() + timeout
        var received = 0L
        connection.inputStream.use { input ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
                val size = input.read(buffer)
                if (size < 0) break
                received += size
                if (received > limit) throw InvalidUpdate()
                if (SystemClock.elapsedRealtime() > deadline) throw IOException("Update download timed out")
                write(buffer, size, received)
            }
        }
        return received
    }
}
