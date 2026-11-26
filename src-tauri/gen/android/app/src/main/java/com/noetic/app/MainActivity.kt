package com.noetic.app

import android.content.ClipboardManager
import android.content.Context
import android.os.Bundle
import android.util.Base64
import android.view.View
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.view.WindowManager
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

// Kept in the repository on purpose: `tauri android init` only creates this file when it is
// missing, so this version is used instead of Tauri's template (which is the same minus the
// keyboard handling below).
class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    makeRoomForKeyboard()
  }

  /**
   * Leaving the screen: the page commits and uploads what is waiting, but Android may pause or
   * close the app before that finishes, or there may be no connection. The background job then
   * finishes it once the phone is online (it does nothing if everything got through).
   */
  override fun onStop() {
    super.onStop()
    SyncJobService.schedule(applicationContext)
  }

  /**
   * The web clipboard API can't read the clipboard inside an Android WebView (the permission is
   * never granted), so the page asks the app instead: `window.NoeticAndroid.readClipboardImage()`.
   */
  override fun onWebViewCreate(webView: WebView) {
    webView.addJavascriptInterface(ClipboardBridge(applicationContext), "NoeticAndroid")
  }

  private class ClipboardBridge(private val context: Context) {
    /**
     * The image at the top of the clipboard as "mime/type;base64data", or "" when there is none.
     * Copied images are on the clipboard as a link to the image (a content:// address), which is
     * read here.
     */
    @JavascriptInterface
    fun readClipboardImage(): String {
      return try {
        val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        val clip = clipboard.primaryClip ?: return ""
        for (i in 0 until clip.itemCount) {
          val uri = clip.getItemAt(i).uri ?: continue
          val type = context.contentResolver.getType(uri)
            ?: (0 until clip.description.mimeTypeCount)
              .map { clip.description.getMimeType(it) }
              .firstOrNull { it.startsWith("image/") }
            ?: continue
          if (!type.startsWith("image/")) continue
          val bytes = context.contentResolver.openInputStream(uri)?.use { it.readBytes() } ?: continue
          if (bytes.size > MAX_BYTES) continue
          return type + ";" + Base64.encodeToString(bytes, Base64.NO_WRAP)
        }
        ""
      } catch (e: Exception) {
        ""
      }
    }

    companion object {
      private const val MAX_BYTES = 40 * 1024 * 1024
    }
  }

  /**
   * The app draws edge to edge (under the status and navigation bars), and in that mode Android
   * draws the keyboard over the app instead of making the app shorter. The page then never learns
   * the keyboard is there: the formatting bar stays at the bottom of the screen behind it, and the
   * line being typed on can sit under it.
   *
   * So the app is made shorter by the height of the keyboard, whatever that is on this device.
   * The navigation bar's part is left out: the page already keeps clear of that itself (CSS
   * safe-area padding), and the keyboard's height includes it.
   */
  private fun makeRoomForKeyboard() {
    @Suppress("DEPRECATION")
    window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)

    val content = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      val keyboard = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
      val navigationBar = insets.getInsets(WindowInsetsCompat.Type.systemBars()).bottom
      view.setPadding(0, 0, 0, maxOf(0, keyboard - navigationBar))
      // Passed on unchanged, so the page still gets the system bar sizes for its safe areas.
      insets
    }
  }
}
