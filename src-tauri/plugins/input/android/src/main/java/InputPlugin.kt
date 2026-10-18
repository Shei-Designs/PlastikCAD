// What the app is being driven with: whether a hardware keyboard is attached
// (a dock, a Bluetooth keyboard) and whether the on-screen keypad is showing.
// Both are read from the system (no permissions needed) and reported again
// the moment they change, so the page can switch between typing in place and
// the entry sheet without guessing.
package com.andrewoshei.bashcad.input

import android.app.Activity
import android.content.Context
import android.content.res.Configuration
import android.hardware.input.InputManager
import android.view.InputDevice
import android.view.View
import android.webkit.WebView
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import kotlin.math.max
import kotlin.math.roundToInt

@TauriPlugin
class InputPlugin(private val activity: Activity) : Plugin(activity), InputManager.InputDeviceListener {
  private var hardwareKeyboard = false
  private var keypadVisible = false
  /** Height of the keypad over the page, in CSS pixels. */
  private var keypadHeight = 0

  override fun load(webView: WebView) {
    hardwareKeyboard = detectKeyboard()
    val inputManager = activity.getSystemService(Context.INPUT_SERVICE) as InputManager
    inputManager.registerInputDeviceListener(this, null)
    // The keypad is seen in the window insets, read on the content view and handed on unchanged
    // (the activity's own listener on the webview keeps working).
    val content = activity.findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { _, insets ->
      val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
      val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
      val visible = insets.isVisible(WindowInsetsCompat.Type.ime()) && ime.bottom > 0
      // The keypad's bottom covers the navigation bar, which the page does not extend under.
      val height = if (visible) (max(0, ime.bottom - bars.bottom) / activity.resources.displayMetrics.density).roundToInt() else 0
      if (visible != keypadVisible || height != keypadHeight) {
        keypadVisible = visible
        keypadHeight = height
        announce()
      }
      insets
    }
  }

  @Command
  fun state(invoke: Invoke) {
    invoke.resolve(current())
  }

  private fun current(): JSObject {
    val out = JSObject()
    out.put("hardwareKeyboard", hardwareKeyboard)
    out.put("keypadVisible", keypadVisible)
    out.put("keypadHeight", keypadHeight)
    return out
  }

  private fun announce() {
    trigger("change", current())
  }

  /** A keyboard the user can type on: what the configuration says, or any attached alphabetic keyboard device. */
  private fun detectKeyboard(): Boolean {
    val config = activity.resources.configuration
    val byConfiguration = config.keyboard == Configuration.KEYBOARD_QWERTY && config.hardKeyboardHidden == Configuration.HARDKEYBOARDHIDDEN_NO
    val byDevices = InputDevice.getDeviceIds().any { id ->
      val device = InputDevice.getDevice(id) ?: return@any false
      !device.isVirtual &&
        (device.sources and InputDevice.SOURCE_KEYBOARD) == InputDevice.SOURCE_KEYBOARD &&
        device.keyboardType == InputDevice.KEYBOARD_TYPE_ALPHABETIC
    }
    return byConfiguration || byDevices
  }

  private fun keyboardMayHaveChanged() {
    val now = detectKeyboard()
    if (now != hardwareKeyboard) {
      hardwareKeyboard = now
      announce()
    }
  }

  override fun onConfigurationChanged(newConfig: Configuration) {
    keyboardMayHaveChanged()
  }

  override fun onResume() {
    keyboardMayHaveChanged()
  }

  override fun onInputDeviceAdded(deviceId: Int) = keyboardMayHaveChanged()
  override fun onInputDeviceRemoved(deviceId: Int) = keyboardMayHaveChanged()
  override fun onInputDeviceChanged(deviceId: Int) = keyboardMayHaveChanged()
}
