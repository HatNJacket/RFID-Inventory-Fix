package com.telcan.rfidsweep;

// TC RFID Sweep — Chainway C72 companion app.
//
// v1.2: RFID ⇄ BARCODE mode toggle (the C72's 2D imager, via the same
// Chainway SDK), scan sounds, and a 1–30 power slider with recommended
// presets. Barcode mode is the capability test for moving the whole batch
// workflow onto this device — capture works and dings; server upload for
// barcodes lands with the batch-flow update.
//
// IMPORTANT on the device: only one app may hold the UHF module / scanner —
// turn off KeyboardEmulator's UHF AND barcode modes first.

import android.app.Activity;
import android.app.AlertDialog;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.Typeface;
import android.media.AudioManager;
import android.media.ToneGenerator;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.WindowManager;
import android.widget.ArrayAdapter;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ListView;
import android.widget.SeekBar;
import android.widget.TextView;
import android.widget.Toast;

import com.rscja.barcode.BarcodeDecoder;
import com.rscja.barcode.BarcodeFactory;
import com.rscja.deviceapi.RFIDWithUHFUART;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public class MainActivity extends Activity {

    private static final String DEFAULT_SERVER =
            "https://telcan-rfid.azurewebsites.net";
    // C72 family trigger keycodes (from Chainway's own demo).
    private static final int[] TRIGGER_KEYS = {
            139, 280, 291, 293, 294, 311, 312, 313, 315, 591, 593, 594, 595, 596
    };
    // Recommended antenna power per job; the slider allows anything 1-30.
    private static final int[] PRESET_LEVELS = {2, 5, 10, 30};
    private static final String[] PRESET_LABELS = {
            "2\nstation", "5\nbin", "10\nrack", "30\nlocate"};

    private RFIDWithUHFUART reader;
    private volatile boolean readerReady = false;
    private volatile boolean scanning = false;
    private volatile boolean listDirty = false;

    private BarcodeDecoder decoder;
    private volatile boolean decoderReady = false;
    private volatile boolean decoderOpening = false;
    private boolean barcodeMode = false;

    private final LinkedHashMap<String, Integer> tags = new LinkedHashMap<>();
    private final LinkedHashMap<String, Integer> codes = new LinkedHashMap<>();
    private final Handler ui = new Handler(Looper.getMainLooper());
    private ToneGenerator tones;

    private SharedPreferences prefs;
    private TextView status;
    private TextView countView;
    private TextView powerLabel;
    private SeekBar powerSeek;
    private Button modeBtn;
    private Button toggleBtn;
    private Button sendBtn;
    private ArrayAdapter<String> adapter;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences("sweep", MODE_PRIVATE);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        try {
            tones = new ToneGenerator(AudioManager.STREAM_MUSIC, 90);
        } catch (Exception ignored) {
        }

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        int pad = dp(12);
        root.setPadding(pad, pad, pad, pad);
        root.setBackgroundColor(Color.parseColor("#f1f2f4"));

        TextView title = new TextView(this);
        title.setText("TC RFID Sweep");
        title.setTextSize(20);
        title.setTypeface(null, Typeface.BOLD);
        title.setTextColor(Color.parseColor("#202223"));
        root.addView(title);

        status = new TextView(this);
        status.setText("Starting the RFID reader…");
        status.setTextColor(Color.parseColor("#6d7175"));
        status.setPadding(0, dp(2), 0, dp(6));
        root.addView(status);

        countView = new TextView(this);
        countView.setText("0 unique tags");
        countView.setTextSize(34);
        countView.setTypeface(null, Typeface.BOLD);
        countView.setGravity(Gravity.CENTER);
        countView.setTextColor(Color.parseColor("#005bd3"));
        countView.setPadding(0, dp(4), 0, dp(8));
        root.addView(countView);

        modeBtn = new Button(this);
        modeBtn.setOnClickListener(v -> toggleMode());
        root.addView(modeBtn);

        // Power: slider 1..30 plus recommended presets underneath. Only
        // affects the RFID antenna; the barcode imager doesn't use it.
        powerLabel = new TextView(this);
        powerLabel.setTypeface(null, Typeface.BOLD);
        powerLabel.setTextColor(Color.parseColor("#202223"));
        powerLabel.setPadding(0, dp(6), 0, 0);
        root.addView(powerLabel);

        powerSeek = new SeekBar(this);
        powerSeek.setMax(29); // progress 0..29 -> power 1..30
        powerSeek.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            @Override
            public void onProgressChanged(SeekBar s, int p, boolean fromUser) {
                powerLabel.setText("RFID power: " + (p + 1));
            }

            @Override
            public void onStartTrackingTouch(SeekBar s) {
            }

            @Override
            public void onStopTrackingTouch(SeekBar s) {
                setPowerLevel(s.getProgress() + 1, true);
            }
        });
        root.addView(powerSeek);

        LinearLayout presetRow = new LinearLayout(this);
        for (int i = 0; i < PRESET_LEVELS.length; i++) {
            final int level = PRESET_LEVELS[i];
            Button b = new Button(this);
            b.setText(PRESET_LABELS[i]);
            b.setTextSize(11);
            b.setAllCaps(false);
            b.setOnClickListener(v -> setPowerLevel(level, true));
            presetRow.addView(b, weight());
        }
        root.addView(presetRow);

        LinearLayout row1 = new LinearLayout(this);
        toggleBtn = new Button(this);
        toggleBtn.setOnClickListener(v -> toggleScan());
        row1.addView(toggleBtn, weight());
        sendBtn = new Button(this);
        sendBtn.setText("SEND SWEEP");
        sendBtn.setOnClickListener(v -> send());
        row1.addView(sendBtn, weight());
        root.addView(row1);

        LinearLayout row2 = new LinearLayout(this);
        Button clearBtn = new Button(this);
        clearBtn.setText("CLEAR");
        clearBtn.setOnClickListener(v -> confirmClear());
        row2.addView(clearBtn, weight());
        Button settingsBtn = new Button(this);
        settingsBtn.setText("SETTINGS");
        settingsBtn.setOnClickListener(v -> showSettings());
        row2.addView(settingsBtn, weight());
        root.addView(row2);

        ListView list = new ListView(this);
        adapter = new ArrayAdapter<>(this, android.R.layout.simple_list_item_1);
        list.setAdapter(adapter);
        root.addView(list, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f));

        setContentView(root);

        restoreSaved();
        barcodeMode = prefs.getBoolean("barcode_mode", false);
        applyMode();
        int power = prefs.getInt("power", 5);
        powerSeek.setProgress(power - 1);
        powerLabel.setText("RFID power: " + power);
        refreshList();
        initReader();
        if (barcodeMode) initBarcode();
        ui.postDelayed(this::refreshTick, 400);
    }

    private LinearLayout.LayoutParams weight() {
        return new LinearLayout.LayoutParams(0,
                LinearLayout.LayoutParams.WRAP_CONTENT, 1f);
    }

    private int dp(int v) {
        return Math.round(getResources().getDisplayMetrics().density * v);
    }

    private void beep(boolean ok) {
        if (tones == null) return;
        try {
            tones.startTone(ok ? ToneGenerator.TONE_PROP_BEEP
                    : ToneGenerator.TONE_CDMA_SOFT_ERROR_LITE, ok ? 120 : 300);
        } catch (Exception ignored) {
        }
    }

    // ------------------------------------------------------------ modes ----
    private LinkedHashMap<String, Integer> active() {
        return barcodeMode ? codes : tags;
    }

    private void applyMode() {
        modeBtn.setText(barcodeMode
                ? "MODE: BARCODE  (tap for RFID)"
                : "MODE: RFID  (tap for barcode)");
        toggleBtn.setText(barcodeMode ? "SCAN BARCODE" : "START SCAN");
        sendBtn.setEnabled(!barcodeMode);
        refreshList();
    }

    private void toggleMode() {
        if (scanning) toggleScan(); // stop RFID inventory first
        barcodeMode = !barcodeMode;
        prefs.edit().putBoolean("barcode_mode", barcodeMode).apply();
        applyMode();
        if (barcodeMode) {
            if (!decoderReady) initBarcode();
            else status.setText("Barcode mode — pull the trigger to scan");
        } else {
            status.setText(readerReady
                    ? "RFID mode — pull the trigger to scan"
                    : "RFID mode — reader not ready");
        }
    }

    // ---------------------------------------------------------- RFID -------
    private void initReader() {
        new Thread(() -> {
            try {
                reader = RFIDWithUHFUART.getInstance();
            } catch (Exception e) {
                ui.post(() -> status.setText(
                        "Reader unavailable: " + e.getMessage()));
                return;
            }
            boolean ok = false;
            try {
                ok = reader.init(getApplicationContext());
            } catch (Exception ignored) {
            }
            if (ok) {
                reader.setInventoryCallback(info -> {
                    String epc = info == null ? null : info.getEPC();
                    if (epc == null || epc.isEmpty()) return;
                    synchronized (tags) {
                        Integer n = tags.get(epc);
                        tags.put(epc, n == null ? 1 : n + 1);
                    }
                    listDirty = true;
                });
            }
            final boolean ready = ok;
            final int power = prefs.getInt("power", 5);
            if (ready) {
                try {
                    reader.setPower(power);
                } catch (Exception ignored) {
                }
            }
            ui.post(() -> {
                readerReady = ready;
                if (!barcodeMode) {
                    status.setText(ready
                            ? "Reader ready (power " + power + ") — pull "
                              + "the trigger to scan"
                            : "Reader init FAILED — is KeyboardEmulator's "
                              + "UHF mode still on? Only one app can hold "
                              + "the module. Turn it off and reopen this "
                              + "app.");
                }
            });
        }).start();
    }

    private void setPowerLevel(int level, boolean announce) {
        final int lv = Math.max(1, Math.min(30, level));
        prefs.edit().putInt("power", lv).apply();
        powerSeek.setProgress(lv - 1);
        powerLabel.setText("RFID power: " + lv);
        if (!readerReady) return;
        final boolean wasScanning = scanning;
        new Thread(() -> {
            try {
                if (wasScanning) reader.stopInventory();
                final boolean ok = reader.setPower(lv);
                if (wasScanning) reader.startInventoryTag();
                if (announce) ui.post(() -> status.setText(ok
                        ? "Power set to " + lv
                        : "Power change FAILED — try again"));
            } catch (Exception e) {
                if (announce) ui.post(() ->
                        status.setText("Power change failed: "
                                + e.getMessage()));
            }
        }).start();
    }

    // --------------------------------------------------------- barcode -----
    private void initBarcode() {
        if (decoderReady || decoderOpening) return;
        decoderOpening = true;
        status.setText("Starting the barcode engine…");
        new Thread(() -> {
            boolean ok = false;
            try {
                decoder = BarcodeFactory.getInstance().getBarcodeDecoder();
                ok = decoder.open(getApplicationContext());
                if (ok) {
                    decoder.setDecodeCallback(entity -> {
                        int rc = entity == null ? -99 : entity.getResultCode();
                        final String data =
                                rc == BarcodeDecoder.DECODE_SUCCESS
                                        ? entity.getBarcodeData() : null;
                        ui.post(() -> onBarcode(rc, data));
                    });
                }
            } catch (Exception ignored) {
            }
            final boolean ready = ok;
            ui.post(() -> {
                decoderOpening = false;
                decoderReady = ready;
                if (barcodeMode) {
                    status.setText(ready
                            ? "Barcode mode — pull the trigger to scan"
                            : "Barcode engine FAILED to open — turn off "
                              + "KeyboardEmulator's barcode/scan mode too, "
                              + "then reopen this app.");
                }
            });
        }).start();
    }

    private void scanBarcodeOnce() {
        if (!decoderReady) {
            if (!decoderOpening) initBarcode();
            return;
        }
        status.setText("Scanning… aim at the barcode");
        try {
            decoder.startScan();
        } catch (Exception e) {
            status.setText("Scan failed: " + e.getMessage());
        }
    }

    private void onBarcode(int resultCode, String data) {
        if (resultCode == BarcodeDecoder.DECODE_SUCCESS && data != null
                && !data.trim().isEmpty()) {
            final String code = data.trim();
            synchronized (codes) {
                Integer n = codes.get(code);
                codes.put(code, n == null ? 1 : n + 1);
            }
            beep(true);
            status.setText("Read: " + code);
            refreshList();
        } else if (resultCode == BarcodeDecoder.DECODE_TIMEOUT) {
            beep(false);
            status.setText("No barcode read — try again");
        } else if (resultCode != BarcodeDecoder.DECODE_CANCEL) {
            beep(false);
            status.setText("Scan error (code " + resultCode + ")");
        }
    }

    // ------------------------------------------------------------ scan -----
    private void toggleScan() {
        if (barcodeMode) {
            scanBarcodeOnce();
            return;
        }
        if (!readerReady) {
            Toast.makeText(this, "Reader not ready", Toast.LENGTH_SHORT).show();
            return;
        }
        if (scanning) {
            reader.stopInventory();
            scanning = false;
            toggleBtn.setText("START SCAN");
            status.setText("Paused — trigger or START to continue, "
                    + "SEND when the shelf is done");
        } else if (reader.startInventoryTag()) {
            scanning = true;
            toggleBtn.setText("STOP SCAN");
            status.setText("Scanning… walk the shelf");
        } else {
            status.setText("Could not start the scan — try again");
        }
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        for (int k : TRIGGER_KEYS) {
            if (keyCode == k) {
                if (event.getRepeatCount() == 0) toggleScan();
                return true;
            }
        }
        return super.onKeyDown(keyCode, event);
    }

    // -------------------------------------------------------------- UI -----
    private void refreshTick() {
        if (listDirty) {
            listDirty = false;
            refreshList();
        }
        ui.postDelayed(this::refreshTick, 400);
    }

    private void refreshList() {
        List<String> rows = new ArrayList<>();
        LinkedHashMap<String, Integer> src = active();
        synchronized (src) {
            countView.setText(src.size()
                    + (barcodeMode ? " unique barcodes" : " unique tags"));
            for (Map.Entry<String, Integer> e : src.entrySet()) {
                rows.add(e.getKey() + "   ×" + e.getValue());
            }
        }
        adapter.clear();
        adapter.addAll(rows);
    }

    private void confirmClear() {
        LinkedHashMap<String, Integer> src = active();
        int n;
        synchronized (src) { n = src.size(); }
        if (n == 0) return;
        new AlertDialog.Builder(this)
                .setMessage("Clear " + n
                        + (barcodeMode ? " barcodes?" : " collected tags?"))
                .setPositiveButton("Clear", (d, w) -> {
                    synchronized (src) { src.clear(); }
                    refreshList();
                    status.setText("Cleared — ready for the next shelf");
                })
                .setNegativeButton("Cancel", null)
                .show();
    }

    // ------------------------------------------------------------- send ----
    private void send() {
        if (barcodeMode) {
            status.setText("Barcode capture is a test for now — the batch "
                    + "workflow upload lands in the next update.");
            return;
        }
        final List<String> epcs = new ArrayList<>();
        synchronized (tags) { epcs.addAll(tags.keySet()); }
        if (epcs.isEmpty()) {
            Toast.makeText(this, "Nothing scanned yet", Toast.LENGTH_SHORT).show();
            return;
        }
        if (scanning) toggleScan();
        final String server = prefs.getString("server", DEFAULT_SERVER)
                .replaceAll("/+$", "");
        final String key = prefs.getString("key", "");
        if (key.isEmpty()) {
            status.setText("Set the station key first (SETTINGS — paste "
                    + "your station link, the key is read from it).");
            showSettings();
            return;
        }
        sendBtn.setEnabled(false);
        status.setText("Sending " + epcs.size() + " tags…");
        new Thread(() -> {
            String result;
            boolean ok = false;
            try {
                JSONObject body = new JSONObject();
                body.put("device", prefs.getString("device", "C72"));
                body.put("epcs", new JSONArray(epcs));
                HttpURLConnection conn = (HttpURLConnection)
                        new URL(server + "/api/epc-captures").openConnection();
                conn.setConnectTimeout(10000);
                conn.setReadTimeout(20000);
                conn.setRequestMethod("POST");
                conn.setRequestProperty("Content-Type", "application/json");
                conn.setRequestProperty("X-Station-Key", key);
                conn.setDoOutput(true);
                try (OutputStream out = conn.getOutputStream()) {
                    out.write(body.toString().getBytes(StandardCharsets.UTF_8));
                }
                int code = conn.getResponseCode();
                if (code == 201) {
                    JSONObject resp = new JSONObject(readAll(
                            conn.getInputStream()));
                    ok = true;
                    result = "Sent ✓ sweep #" + resp.optInt("id")
                            + " (" + epcs.size() + " tags). Pull it on the "
                            + "PC's verify screen. CLEAR before the next shelf.";
                } else {
                    result = "Send FAILED (HTTP " + code + ") — tags "
                            + "kept on the device; get Wi-Fi and try again."
                            + (code == 401 ? " Check the station key in "
                            + "SETTINGS." : "");
                }
                conn.disconnect();
            } catch (Exception e) {
                result = "Send FAILED (" + e.getClass().getSimpleName()
                        + ") — tags kept on the device; get Wi-Fi "
                        + "coverage and press SEND again.";
            }
            final String msg = result;
            final boolean sent = ok;
            ui.post(() -> {
                status.setText(msg);
                sendBtn.setEnabled(!barcodeMode);
                if (sent) Toast.makeText(this, "Sweep sent ✓",
                        Toast.LENGTH_LONG).show();
            });
        }).start();
    }

    private static String readAll(InputStream in) throws Exception {
        StringBuilder sb = new StringBuilder();
        try (BufferedReader r = new BufferedReader(
                new InputStreamReader(in, StandardCharsets.UTF_8))) {
            String line;
            while ((line = r.readLine()) != null) sb.append(line);
        }
        return sb.toString();
    }

    // --------------------------------------------------------- settings ----
    private void showSettings() {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        int pad = dp(16);
        box.setPadding(pad, pad, pad, 0);

        final EditText serverIn = new EditText(this);
        serverIn.setHint("Server or station link (key is read from ?key=)");
        serverIn.setInputType(InputType.TYPE_TEXT_VARIATION_URI);
        serverIn.setText(prefs.getString("server", DEFAULT_SERVER));
        box.addView(serverIn);

        final EditText keyIn = new EditText(this);
        keyIn.setHint("Station key");
        keyIn.setText(prefs.getString("key", ""));
        box.addView(keyIn);

        final EditText deviceIn = new EditText(this);
        deviceIn.setHint("Device name");
        deviceIn.setText(prefs.getString("device", "C72"));
        box.addView(deviceIn);

        new AlertDialog.Builder(this)
                .setTitle("Settings")
                .setView(box)
                .setPositiveButton("Save", (d, w) -> {
                    String server = serverIn.getText().toString().trim();
                    String key = keyIn.getText().toString().trim();
                    // Pasting the full station link is easiest on this
                    // keyboard: pull the key out of ?key=... and keep the
                    // bare server URL.
                    int q = server.indexOf('?');
                    if (q >= 0) {
                        for (String part : server.substring(q + 1).split("&")) {
                            if (part.startsWith("key=")) {
                                key = part.substring(4);
                            }
                        }
                        server = server.substring(0, q);
                    }
                    server = server.replaceAll("/+$", "");
                    if (server.isEmpty()) server = DEFAULT_SERVER;
                    prefs.edit().putString("server", server)
                            .putString("key", key)
                            .putString("device",
                                    deviceIn.getText().toString().trim())
                            .apply();
                    status.setText(key.isEmpty()
                            ? "Saved — but the station key is still empty"
                            : "Settings saved ✓");
                })
                .setNegativeButton("Cancel", null)
                .show();
    }

    // ------------------------------------------------------- persistence ----
    private void restoreSaved() {
        restoreMap("saved_tags", tags);
        restoreMap("saved_codes", codes);
    }

    private void restoreMap(String prefKey, LinkedHashMap<String, Integer> map) {
        String saved = prefs.getString(prefKey, "");
        if (saved.isEmpty()) return;
        synchronized (map) {
            for (String line : saved.split("\n")) {
                int sep = line.lastIndexOf('|');
                if (sep <= 0) continue;
                try {
                    map.put(line.substring(0, sep),
                            Integer.parseInt(line.substring(sep + 1)));
                } catch (NumberFormatException ignored) {
                }
            }
        }
    }

    private void saveMap(String prefKey, LinkedHashMap<String, Integer> map) {
        StringBuilder sb = new StringBuilder();
        synchronized (map) {
            for (Map.Entry<String, Integer> e : map.entrySet()) {
                sb.append(e.getKey()).append('|').append(e.getValue())
                        .append('\n');
            }
        }
        prefs.edit().putString(prefKey, sb.toString()).apply();
    }

    @Override
    protected void onPause() {
        super.onPause();
        saveMap("saved_tags", tags);
        saveMap("saved_codes", codes);
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        try {
            if (scanning) reader.stopInventory();
            if (readerReady) reader.free();
        } catch (Exception ignored) {
        }
        try {
            if (decoderReady) decoder.close();
        } catch (Exception ignored) {
        }
        try {
            if (tones != null) tones.release();
        } catch (Exception ignored) {
        }
    }
}
