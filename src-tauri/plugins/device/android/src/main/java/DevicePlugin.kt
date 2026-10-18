// What the app runs on: whether a hardware keyboard is attached (a dock, a
// Bluetooth keyboard) and whether the on-screen keypad is showing, both read
// from the system (no permissions needed) and reported again the moment they
// change, so the page can switch between typing in place and the entry sheet
// without guessing. Also writes the documents the system pickers hand out.
package com.andrewoshei.bashcad.device

import android.app.Activity
import android.content.Intent
import android.content.Context
import android.content.res.Configuration
import android.hardware.input.InputManager
import android.net.Uri
import android.provider.DocumentsContract
import androidx.activity.result.ActivityResult
import android.view.InputDevice
import android.view.View
import android.webkit.WebView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import kotlin.math.max
import kotlin.math.roundToInt

@InvokeArg
internal class CreateDocumentArgs {
  /** A document URI from `pickFolder` or an earlier `createDocument`. */
  lateinit var parent: String
  lateinit var name: String
  /** The document's type; `vnd.android.document/directory` makes a folder. */
  lateinit var mime: String
}

@InvokeArg
internal class WriteDocumentArgs {
  lateinit var uri: String
  /** A file holding the bytes, copied in and then deleted. */
  lateinit var source: String
}

@TauriPlugin
class DevicePlugin(activity: Activity) : Plugin(activity), InputManager.InputDeviceListener {
  private var hardwareKeyboard = false
  private var keypadVisible = false
  /** Height of the keypad over the page, in CSS pixels. */
  private var keypadHeight = 0

  /**
   * The activity on screen. The plugin lives as long as the process, while Android may
   * rebuild the activity (a dock that changes the display, say), so this is taken afresh
   * from every lifecycle call rather than kept from construction.
   */
  private var host: Activity = activity
  /** The content view whose window insets are being watched. */
  private var watched: View? = null

  override fun load(webView: WebView) {
    (webView.context as? Activity)?.let { host = it }
    hardwareKeyboard = detectKeyboard()
    val inputManager = host.getSystemService(Context.INPUT_SERVICE) as InputManager
    inputManager.registerInputDeviceListener(this, null)
    watchKeypad()
  }

  /**
   * The keypad is seen in the window insets, read on the content view and handed on unchanged
   * (the activity's own listener on the webview keeps working). Attached again whenever the
   * content view is a new one.
   */
  private fun watchKeypad() {
    val content = host.findViewById<View>(android.R.id.content) ?: return
    if (watched === content) return
    watched = content
    ViewCompat.setOnApplyWindowInsetsListener(content) { _, insets ->
      readKeypad(insets)
      insets
    }
    ViewCompat.getRootWindowInsets(content)?.let { readKeypad(it) }
    content.requestApplyInsets()
  }

  private fun readKeypad(insets: WindowInsetsCompat) {
    val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
    val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
    val visible = insets.isVisible(WindowInsetsCompat.Type.ime()) && ime.bottom > 0
    // The keypad's bottom covers the navigation bar, which the page does not extend under.
    val height = if (visible) (max(0, ime.bottom - bars.bottom) / host.resources.displayMetrics.density).roundToInt() else 0
    if (visible != keypadVisible || height != keypadHeight) {
      keypadVisible = visible
      keypadHeight = height
      announce()
    }
  }

  /**
   * Copies a file into a document picked through the system dialog, by way of the document's
   * provider: closing the provider's own stream is what tells it the document's new size, which a
   * raw descriptor never does (the Files app then shows the export as 0 B).
   */
  @Command
  fun writeDocument(invoke: Invoke) {
    val args = invoke.parseArgs(WriteDocumentArgs::class.java)
    val source = File(args.source)
    try {
      val out = host.contentResolver.openOutputStream(Uri.parse(args.uri), "wt")
        ?: throw IllegalStateException("The document could not be opened for writing")
      out.use { sink -> source.inputStream().use { it.copyTo(sink) } }
      invoke.resolve()
    } catch (e: Exception) {
      invoke.reject(e.message ?: "Could not write the document")
    } finally {
      source.delete()
    }
  }

  /** Asks for a folder; resolves with its document URI, or null if the picker was dismissed. */
  @Command
  fun pickFolder(invoke: Invoke) {
    val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE)
    startActivityForResult(invoke, intent, "folderPicked")
  }

  @ActivityCallback
  fun folderPicked(invoke: Invoke, result: ActivityResult) {
    val out = JSObject()
    val tree = if (result.resultCode == Activity.RESULT_OK) result.data?.data else null
    if (tree == null) {
      out.put("uri", null)
    } else {
      // Granted for as long as the app runs, which is as long as the export takes.
      host.contentResolver.takePersistableUriPermission(tree, Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
      out.put("uri", DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree)).toString())
    }
    invoke.resolve(out)
  }

  /** Makes a document (or a folder) inside another; resolves with its URI. The provider may vary the name to keep it unique. */
  @Command
  fun createDocument(invoke: Invoke) {
    val args = invoke.parseArgs(CreateDocumentArgs::class.java)
    try {
      val made = DocumentsContract.createDocument(host.contentResolver, Uri.parse(args.parent), args.mime, args.name)
        ?: throw IllegalStateException("The folder did not accept a new document")
      val out = JSObject()
      out.put("uri", made.toString())
      invoke.resolve(out)
    } catch (e: Exception) {
      invoke.reject(e.message ?: "Could not create the document")
    }
  }

  @Command
  fun state(invoke: Invoke) {
    // Asked afresh: the insets are read again in case a change went by unseen.
    watchKeypad()
    watched?.let { view -> ViewCompat.getRootWindowInsets(view)?.let { readKeypad(it) } }
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
  private fun detectKeyboard(config: Configuration = host.resources.configuration): Boolean {
    val byConfiguration = config.keyboard == Configuration.KEYBOARD_QWERTY && config.hardKeyboardHidden == Configuration.HARDKEYBOARDHIDDEN_NO
    val byDevices = InputDevice.getDeviceIds().any { id ->
      val device = InputDevice.getDevice(id) ?: return@any false
      !device.isVirtual &&
        (device.sources and InputDevice.SOURCE_KEYBOARD) == InputDevice.SOURCE_KEYBOARD &&
        device.keyboardType == InputDevice.KEYBOARD_TYPE_ALPHABETIC
    }
    return byConfiguration || byDevices
  }

  private fun keyboardMayHaveChanged(config: Configuration = host.resources.configuration) {
    val now = detectKeyboard(config)
    if (now != hardwareKeyboard) {
      hardwareKeyboard = now
      announce()
    }
    watchKeypad()
    watched?.let { view -> ViewCompat.getRootWindowInsets(view)?.let { readKeypad(it) } }
  }

  override fun onConfigurationChanged(newConfig: Configuration) {
    keyboardMayHaveChanged(newConfig)
  }

  override fun onRestart(activity: AppCompatActivity) {
    host = activity
  }

  override fun onResume(activity: AppCompatActivity) {
    host = activity
    keyboardMayHaveChanged()
  }

  override fun onInputDeviceAdded(deviceId: Int) = keyboardMayHaveChanged()
  override fun onInputDeviceRemoved(deviceId: Int) = keyboardMayHaveChanged()
  override fun onInputDeviceChanged(deviceId: Int) = keyboardMayHaveChanged()
}
