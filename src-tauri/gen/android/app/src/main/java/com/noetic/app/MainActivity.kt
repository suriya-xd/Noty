package com.noetic.app

import android.os.Bundle
import android.view.View
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
