// What the app runs on: whether a hardware keyboard is attached (a dock, a
// Bluetooth keyboard) and whether the on-screen keypad is showing, both read
// from the system (no permissions needed) and reported again the moment they
// change, so the page can switch between typing in place and the entry sheet
// without guessing. Also writes the documents the system pickers hand out.
package com.andrewoshei.bashcad.device

import android.app.Activity
import android.content.ContentValues
import android.content.Intent
import android.content.Context
import android.content.res.Configuration
import android.hardware.input.InputManager
import android.net.Uri
import android.os.Build
import android.provider.DocumentsContract
import android.provider.MediaStore
import androidx.activity.result.ActivityResult
import android.view.InputDevice
import android.view.View
import android.webkit.MimeTypeMap
import android.webkit.WebView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
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
internal class MimeForArgs {
  lateinit var name: String
  lateinit var mime: String
}

@InvokeArg
internal class ExportArgs {
  /** Folder under the app's own folder in Downloads; empty for the app's folder itself. */
  lateinit var folder: String
  lateinit var name: String
  lateinit var mime: String
  /** A file holding the bytes, copied in and then deleted. */
  lateinit var source: String
}

@InvokeArg
internal class ShareArgs {
  lateinit var uris: List<String>
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

  /**
   * A type to create a document of the given name as, such that the name is kept: a provider
   * appends the extension it knows for the type when the name's own does not fit it (so a
   * `.mtl` made as text/plain comes out `.mtl.txt`). Where the system knows no type for the
   * extension, a private one keeps it from adding any.
   */
  private fun mimeFor(name: String, wanted: String): String {
    val extension = name.substringAfterLast('.', "").lowercase()
    if (extension.isEmpty() || extension == name.lowercase()) return wanted
    val map = MimeTypeMap.getSingleton()
    val forWanted = map.getExtensionFromMimeType(wanted)
    if (forWanted == null || forWanted.equals(extension, ignoreCase = true)) return wanted
    return map.getMimeTypeFromExtension(extension) ?: "application/x-$extension"
  }

  /** The type the system save dialog should create a document of this name as, for the name to be kept. */
  @Command
  fun mimeFor(invoke: Invoke) {
    val args = invoke.parseArgs(MimeForArgs::class.java)
    val out = JSObject()
    out.put("mime", mimeFor(args.name, args.mime))
    invoke.resolve(out)
  }

  /** Makes a document (or a folder) inside another; resolves with its URI. The provider may vary the name to keep it unique. */
  @Command
  fun createDocument(invoke: Invoke) {
    val args = invoke.parseArgs(CreateDocumentArgs::class.java)
    try {
      val mime = if (args.mime == DocumentsContract.Document.MIME_TYPE_DIR) args.mime else mimeFor(args.name, args.mime)
      val made = DocumentsContract.createDocument(host.contentResolver, Uri.parse(args.parent), mime, args.name)
        ?: throw IllegalStateException("The folder did not accept a new document")
      val out = JSObject()
      out.put("uri", made.toString())
      invoke.resolve(out)
    } catch (e: Exception) {
      invoke.reject(e.message ?: "Could not create the document")
    }
  }

  /**
   * Writes an export into the app's own folder in Downloads (`Download/BashCAD/<folder>/`), where
   * the Files app and other apps can see it, through the media store, which needs no permission
   * for the app's own files. A file of the same name there is replaced. Resolves with the file's
   * content URI (for sharing) and its path as the Files app shows it.
   */
  @Command
  fun exportToDownloads(invoke: Invoke) {
    val args = invoke.parseArgs(ExportArgs::class.java)
    val source = File(args.source)
    try {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) throw IllegalStateException("Exports to Downloads need Android 10 or later")
      val relative = "Download/BashCAD" + (if (args.folder.isEmpty()) "" else "/" + args.folder) + "/"
      val resolver = host.contentResolver
      val collection = MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
      // The media store would give a second file a numbered name; the old one goes first.
      resolver.query(collection, arrayOf(MediaStore.Downloads._ID), "${MediaStore.Downloads.RELATIVE_PATH} = ? AND ${MediaStore.Downloads.DISPLAY_NAME} = ?", arrayOf(relative, args.name), null)?.use { rows ->
        while (rows.moveToNext()) resolver.delete(android.content.ContentUris.withAppendedId(collection, rows.getLong(0)), null, null)
      }
      val values = ContentValues().apply {
        put(MediaStore.Downloads.DISPLAY_NAME, args.name)
        put(MediaStore.Downloads.MIME_TYPE, mimeFor(args.name, args.mime))
        put(MediaStore.Downloads.RELATIVE_PATH, relative)
        put(MediaStore.Downloads.IS_PENDING, 1)
      }
      val uri = resolver.insert(collection, values) ?: throw IllegalStateException("Downloads did not accept the file")
      val out = resolver.openOutputStream(uri, "wt") ?: throw IllegalStateException("The file could not be opened for writing")
      out.use { sink -> source.inputStream().use { it.copyTo(sink) } }
      values.clear()
      values.put(MediaStore.Downloads.IS_PENDING, 0)
      resolver.update(uri, values, null, null)
      val result = JSObject()
      result.put("uri", uri.toString())
      result.put("path", relative + args.name)
      invoke.resolve(result)
    } catch (e: Exception) {
      invoke.reject(e.message ?: "Could not write the export")
    } finally {
      source.delete()
    }
  }

  /** Opens the system share sheet with the given files. */
  @Command
  fun share(invoke: Invoke) {
    val args = invoke.parseArgs(ShareArgs::class.java)
    try {
      val uris = ArrayList<Uri>(args.uris.map { Uri.parse(it) })
      val intent = if (uris.size == 1) {
        Intent(Intent.ACTION_SEND).putExtra(Intent.EXTRA_STREAM, uris[0])
      } else {
        Intent(Intent.ACTION_SEND_MULTIPLE).putParcelableArrayListExtra(Intent.EXTRA_STREAM, uris)
      }
      intent.type = args.mime
      intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      host.startActivity(Intent.createChooser(intent, null))
      invoke.resolve()
    } catch (e: Exception) {
      invoke.reject(e.message ?: "Could not share")
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
