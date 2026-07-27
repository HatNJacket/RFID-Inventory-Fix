package com.telcan.rfidsweep;

// TC RFID Sweep — Chainway C72 companion app.
//
// v1.5: the batch-tagging workflow lives ON the C72. Pick an open batch
// (started on the PC/iPad), then:
//   COLLECT — Bluetooth barcode scanner scans boxes; every scan posts to
//     the server, dings by outcome (expected / valid-but-unexpected /
//     unknown), and ticks the product's n/N counter.
//   PAIR — scan a product's barcode to select it, then pull the TRIGGER on
//     each applied RFID sticker: single tag read -> paired server-side.
//     Duplicates are rejected with the owning product. UNDO takes back the
//     last tag.
//   FINISH — shows the stock deltas ("5 -> 6 (+1)") for confirmation, then
//     completes the batch (mismatches become Review tasks on the PC).
// Every action is a server write, so any browser with the same batch open
// mirrors this device live (~3s).
//
// This unit has no built-in imager: barcodes come from the paired
// Bluetooth scanner (it types like a keyboard into the capture box).
// The RFID trigger stays SDK-driven. Only one app may hold the UHF
// module — keep KeyboardEmulator's UHF mode off.

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
import android.text.Editable;
import android.text.InputType;
import android.text.TextWatcher;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowManager;
import android.widget.ArrayAdapter;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ListView;
import android.widget.SeekBar;
import android.widget.TextView;
import android.widget.Toast;

import com.rscja.barcode.Barcode2DSHardwareInfo;
import com.rscja.barcode.BarcodeDecoder;
import com.rscja.barcode.BarcodeFactory;
import com.rscja.deviceapi.RFIDWithUHFUART;
import com.rscja.deviceapi.entity.UHFTAGInfo;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
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
    private static final int[] PRESET_LEVELS = {2, 5, 10, 30};
    private static final String[] PRESET_LABELS = {
            "2\nstation", "5\nbin", "10\nrack", "30\nlocate"};

    private static final int SOUND_OK = 0;     // expected match
    private static final int SOUND_OTHER = 1;  // valid but unexpected
    private static final int SOUND_ERR = 2;    // no match / failure

    private RFIDWithUHFUART reader;
    private volatile boolean readerReady = false;
    private volatile boolean scanning = false;
    private volatile boolean listDirty = false;

    private BarcodeDecoder decoder;
    private volatile boolean decoderReady = false;
    private volatile boolean decoderOpening = false;
    private volatile boolean decoderFailed = false;
    private volatile String engineInfo = "engine unknown";
    private boolean barcodeMode = false;

    // Plain (non-batch) capture stores.
    private final LinkedHashMap<String, Integer> tags = new LinkedHashMap<>();
    private final LinkedHashMap<String, Integer> codes = new LinkedHashMap<>();

    // ------------------------------------------------------- batch state ----
    private static class BItem {
        int id;
        String title = "";
        String variant;
        String sku;
        String barcode;
        String serialPrefix;
        boolean resolved;
        int qty;
        Integer expected; // null = Shopify had no number
        int paired;

        static BItem from(JSONObject o) {
            BItem b = new BItem();
            b.id = o.optInt("id");
            b.title = o.isNull("product_title") ? ""
                    : o.optString("product_title", "");
            b.variant = o.isNull("variant_title") ? null
                    : o.optString("variant_title");
            b.sku = o.isNull("sku") ? null : o.optString("sku");
            b.barcode = o.isNull("barcode") ? null : o.optString("barcode");
            b.serialPrefix = o.isNull("serial_prefix") ? null
                    : o.optString("serial_prefix");
            b.resolved = o.optBoolean("resolved", false);
            b.qty = o.optInt("qty_scanned", 0);
            b.expected = o.isNull("expected_qty") ? null
                    : o.optInt("expected_qty");
            b.paired = o.optInt("paired_count", 0);
            return b;
        }

        String name() {
            String n = title == null || title.isEmpty() ? "(unknown)" : title;
            if (variant != null && !variant.isEmpty()) n += " (" + variant + ")";
            return n;
        }
    }

    private int batchId = -1;
    private String batchBin = null;
    private boolean pairPhase = false;
    private final List<BItem> bItems = new ArrayList<>();
    private BItem pairActive = null;
    private final ArrayDeque<String[]> pairHistory = new ArrayDeque<>();
    private volatile boolean tagReadBusy = false;

    private final Handler ui = new Handler(Looper.getMainLooper());
    private ToneGenerator tones;

    private SharedPreferences prefs;
    private TextView status;
    private TextView countView;
    private TextView powerLabel;
    private SeekBar powerSeek;
    private EditText btInput;
    private Button modeBtn;
    private Button batchBtn;
    private Button toggleBtn;
    private Button sendBtn;
    private Button clearBtn;
    private Button settingsBtn;
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
        countView.setTextSize(26);
        countView.setTypeface(null, Typeface.BOLD);
        countView.setGravity(Gravity.CENTER);
        countView.setTextColor(Color.parseColor("#005bd3"));
        countView.setPadding(0, dp(2), 0, dp(4));
        root.addView(countView);

        LinearLayout topRow = new LinearLayout(this);
        modeBtn = new Button(this);
        modeBtn.setAllCaps(false);
        modeBtn.setOnClickListener(v -> toggleMode());
        topRow.addView(modeBtn, weight());
        batchBtn = new Button(this);
        batchBtn.setText("BATCH…");
        batchBtn.setOnClickListener(v -> openBatchPicker());
        topRow.addView(batchBtn, weight());
        root.addView(topRow);

        // Paired Bluetooth barcode scanner types here (it's a keyboard).
        btInput = new EditText(this);
        btInput.setHint("Bluetooth scanner scans land here");
        btInput.setInputType(InputType.TYPE_CLASS_TEXT
                | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
        btInput.setShowSoftInputOnFocus(false);
        btInput.setVisibility(View.GONE);
        btInput.addTextChangedListener(new TextWatcher() {
            @Override
            public void beforeTextChanged(CharSequence s, int a, int b, int c) {
            }

            @Override
            public void onTextChanged(CharSequence s, int a, int b, int c) {
            }

            @Override
            public void afterTextChanged(Editable s) {
                String text = s.toString();
                if (text.contains("\n") || text.contains("\r")) {
                    String code = text.replace("\n", "").replace("\r", "")
                            .trim();
                    btInput.setText("");
                    if (!code.isEmpty()) onScanInput(code);
                }
            }
        });
        btInput.setOnEditorActionListener((v, actionId, ev) -> {
            String code = btInput.getText().toString().trim();
            btInput.setText("");
            if (!code.isEmpty()) onScanInput(code);
            return true;
        });
        root.addView(btInput);

        powerLabel = new TextView(this);
        powerLabel.setTypeface(null, Typeface.BOLD);
        powerLabel.setTextColor(Color.parseColor("#202223"));
        powerLabel.setPadding(0, dp(4), 0, 0);
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
        toggleBtn.setOnClickListener(v -> onToggleButton());
        row1.addView(toggleBtn, weight());
        sendBtn = new Button(this);
        sendBtn.setOnClickListener(v -> onSendButton());
        row1.addView(sendBtn, weight());
        root.addView(row1);

        LinearLayout row2 = new LinearLayout(this);
        clearBtn = new Button(this);
        clearBtn.setOnClickListener(v -> onClearButton());
        row2.addView(clearBtn, weight());
        settingsBtn = new Button(this);
        settingsBtn.setOnClickListener(v -> onSettingsButton());
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

    private void beep(int kind) {
        if (tones == null) return;
        try {
            if (kind == SOUND_OK) {
                tones.startTone(ToneGenerator.TONE_PROP_BEEP, 120);
            } else if (kind == SOUND_OTHER) {
                tones.startTone(ToneGenerator.TONE_PROP_BEEP2, 200);
            } else {
                tones.startTone(ToneGenerator.TONE_CDMA_SOFT_ERROR_LITE, 300);
            }
        } catch (Exception ignored) {
        }
    }

    private boolean inBatch() {
        return batchId >= 0;
    }

    // ---------------------------------------------------- button routing ----
    private void onToggleButton() {
        if (inBatch()) {
            pairPhase = !pairPhase;
            pairActive = null;
            applyBatchUi();
        } else {
            toggleScan();
        }
    }

    private void onSendButton() {
        if (inBatch()) finishBatch();
        else send();
    }

    private void onClearButton() {
        if (inBatch()) undoPair();
        else confirmClear();
    }

    private void onSettingsButton() {
        if (inBatch()) exitBatch(false);
        else showSettings();
    }

    // Every barcode (BT scanner or built-in imager) funnels through here.
    private void onScanInput(String code) {
        if (inBatch()) {
            if (pairPhase) pairSelect(code);
            else batchScan(code);
        } else {
            onBarcode(BarcodeDecoder.DECODE_SUCCESS, code);
        }
    }

    // ------------------------------------------------------------ modes ----
    private LinkedHashMap<String, Integer> active() {
        return barcodeMode ? codes : tags;
    }

    private void applyMode() {
        modeBtn.setText(barcodeMode ? "MODE: BARCODE" : "MODE: RFID");
        toggleBtn.setText(barcodeMode ? "SCAN BARCODE" : "START SCAN");
        sendBtn.setText("SEND SWEEP");
        sendBtn.setEnabled(!barcodeMode);
        clearBtn.setText("CLEAR");
        settingsBtn.setText("SETTINGS");
        modeBtn.setVisibility(View.VISIBLE);
        batchBtn.setVisibility(View.VISIBLE);
        btInput.setVisibility(barcodeMode ? View.VISIBLE : View.GONE);
        if (barcodeMode) btInput.requestFocus();
        refreshList();
    }

    private void toggleMode() {
        if (scanning) toggleScan();
        barcodeMode = !barcodeMode;
        prefs.edit().putBoolean("barcode_mode", barcodeMode).apply();
        applyMode();
        if (barcodeMode) {
            if (!decoderReady && !decoderFailed) initBarcode();
            else status.setText("Barcode mode — scan with the BT scanner");
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
                if (!barcodeMode && !inBatch()) {
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
            try {
                Barcode2DSHardwareInfo hw = Barcode2DSHardwareInfo.getInstance();
                engineInfo = (hw.getManufactor() + " " + hw.getEngineName())
                        .trim();
            } catch (Exception e) {
                engineInfo = "engine lookup failed";
            }
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
                        ui.post(() -> {
                            if (rc == BarcodeDecoder.DECODE_SUCCESS
                                    && data != null) {
                                onScanInput(data.trim());
                            } else {
                                onBarcode(rc, null);
                            }
                        });
                    });
                }
            } catch (Exception ignored) {
            }
            final boolean ready = ok;
            ui.post(() -> {
                decoderOpening = false;
                decoderReady = ready;
                decoderFailed = !ready;
                if (barcodeMode && !inBatch()) {
                    status.setText(ready
                            ? "Barcode mode (" + engineInfo + ") — pull "
                              + "the trigger, or use the BT scanner"
                            : "No built-in imager (" + engineInfo + ") — "
                              + "pair your Bluetooth scanner (C72 "
                              + "Settings > Bluetooth); its reads land "
                              + "in the box above.");
                }
            });
        }).start();
    }

    private void scanBarcodeOnce() {
        if (!decoderReady) {
            if (decoderFailed) {
                status.setText("No built-in imager on this unit — scan "
                        + "with the Bluetooth scanner (its reads land in "
                        + "the box above).");
            } else if (!decoderOpening) {
                initBarcode();
            }
            return;
        }
        status.setText("Scanning… aim at the barcode");
        try {
            decoder.stopScan();
        } catch (Exception ignored) {
        }
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
            beep(SOUND_OK);
            status.setText("Read: " + code);
            refreshList();
            if (barcodeMode) btInput.requestFocus();
        } else if (resultCode == BarcodeDecoder.DECODE_TIMEOUT) {
            beep(SOUND_ERR);
            status.setText("No barcode read — try again");
        } else if (resultCode == BarcodeDecoder.DECODE_FAILURE) {
            beep(SOUND_ERR);
            status.setText("Decode FAILED (-2, " + engineInfo + "). Use "
                    + "the Bluetooth scanner instead.");
        } else if (resultCode != BarcodeDecoder.DECODE_CANCEL
                && resultCode != -99) {
            beep(SOUND_ERR);
            status.setText("Scan error (code " + resultCode + ", "
                    + engineInfo + ")");
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
                if (event.getRepeatCount() == 0) {
                    if (inBatch()) {
                        if (pairPhase) pairReadTag();
                        else {
                            beep(SOUND_ERR);
                            status.setText("COLLECT phase uses the barcode "
                                    + "scanner. Switch to PAIR to read "
                                    + "RFID stickers.");
                        }
                    } else {
                        toggleScan();
                    }
                }
                return true;
            }
        }
        return super.onKeyDown(keyCode, event);
    }

    // ------------------------------------------------------------- HTTP ----
    private JSONObject api(String method, String path, JSONObject body)
            throws Exception {
        String server = prefs.getString("server", DEFAULT_SERVER)
                .replaceAll("/+$", "");
        String key = prefs.getString("key", "");
        if (key.isEmpty()) {
            throw new Exception("Station key not set — open SETTINGS and "
                    + "paste your station link.");
        }
        HttpURLConnection conn = (HttpURLConnection)
                new URL(server + path).openConnection();
        conn.setConnectTimeout(10000);
        conn.setReadTimeout(20000);
        conn.setRequestMethod(method);
        conn.setRequestProperty("X-Station-Key", key);
        if (body != null) {
            conn.setRequestProperty("Content-Type", "application/json");
            conn.setDoOutput(true);
            try (OutputStream out = conn.getOutputStream()) {
                out.write(body.toString().getBytes(StandardCharsets.UTF_8));
            }
        }
        int code = conn.getResponseCode();
        InputStream in = code >= 400 ? conn.getErrorStream()
                : conn.getInputStream();
        String text = in == null ? "" : readAll(in);
        conn.disconnect();
        if (code >= 400) {
            String detail = "HTTP " + code;
            try {
                detail = new JSONObject(text).optString("detail", detail);
            } catch (Exception ignored) {
            }
            throw new Exception(detail);
        }
        return text.isEmpty() ? new JSONObject() : new JSONObject(text);
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

    // ------------------------------------------------------------ batch ----
    private void openBatchPicker() {
        status.setText("Loading open batches…");
        new Thread(() -> {
            try {
                JSONObject resp = api("GET", "/api/batches?status=open", null);
                JSONArray bs = resp.getJSONArray("batches");
                final List<String> labels = new ArrayList<>();
                final List<Integer> ids = new ArrayList<>();
                for (int i = 0; i < bs.length(); i++) {
                    JSONObject b = bs.getJSONObject(i);
                    labels.add("Bin " + b.optString("bin_name") + "  ·  "
                            + b.optInt("boxes") + " boxes · "
                            + b.optInt("paired") + " tags  (#"
                            + b.optInt("id") + ")");
                    ids.add(b.optInt("id"));
                }
                ui.post(() -> {
                    if (labels.isEmpty()) {
                        status.setText("No open batches. Start one in Batch "
                                + "tagging on the PC or iPad first.");
                        return;
                    }
                    new AlertDialog.Builder(this)
                            .setTitle("Open batch")
                            .setItems(labels.toArray(new String[0]),
                                    (d, which) -> enterBatch(ids.get(which)))
                            .setNegativeButton("Cancel", null)
                            .show();
                });
            } catch (Exception e) {
                ui.post(() -> status.setText("Could not load batches: "
                        + e.getMessage()));
            }
        }).start();
    }

    private void enterBatch(int id) {
        status.setText("Loading batch #" + id + "…");
        new Thread(() -> {
            try {
                JSONObject resp = api("GET", "/api/batches/" + id, null);
                JSONObject b = resp.getJSONObject("batch");
                JSONArray items = resp.getJSONArray("items");
                final List<BItem> loaded = new ArrayList<>();
                for (int i = 0; i < items.length(); i++) {
                    loaded.add(BItem.from(items.getJSONObject(i)));
                }
                final String bin = b.optString("bin_name");
                final String st = b.optString("status");
                ui.post(() -> {
                    if (scanning) toggleScan();
                    batchId = id;
                    batchBin = bin;
                    bItems.clear();
                    bItems.addAll(loaded);
                    pairPhase = "printing".equals(st) || "pairing".equals(st);
                    pairActive = null;
                    pairHistory.clear();
                    applyBatchUi();
                });
            } catch (Exception e) {
                ui.post(() -> status.setText("Could not load batch: "
                        + e.getMessage()));
            }
        }).start();
    }

    private void applyBatchUi() {
        modeBtn.setVisibility(View.GONE);
        batchBtn.setVisibility(View.GONE);
        btInput.setVisibility(View.VISIBLE);
        btInput.requestFocus();
        toggleBtn.setText(pairPhase
                ? "PHASE: PAIR  (tap for collect)"
                : "PHASE: COLLECT  (tap for pair)");
        sendBtn.setText("FINISH BATCH");
        sendBtn.setEnabled(true);
        clearBtn.setText("UNDO TAG");
        settingsBtn.setText("EXIT BATCH");
        status.setText(pairPhase
                ? "PAIR: scan a product barcode, then TRIGGER on each of "
                  + "its stickers"
                : "COLLECT: scan every box in bin " + batchBin
                  + " with the barcode scanner");
        refreshBatchList();
    }

    private void exitBatch(boolean completed) {
        batchId = -1;
        batchBin = null;
        bItems.clear();
        pairActive = null;
        pairHistory.clear();
        pairPhase = false;
        applyMode();
        if (!completed) {
            status.setText("Left the batch (still open — resume any time "
                    + "from BATCH… or the PC).");
        }
    }

    private BItem itemById(int id) {
        for (BItem b : bItems) if (b.id == id) return b;
        return null;
    }

    private void refreshBatchList() {
        int boxes = 0, started = 0, expected = 0, paired = 0;
        List<String> rows = new ArrayList<>();
        List<BItem> sorted = new ArrayList<>();
        for (BItem b : bItems) if (b.qty > 0 || b.paired > 0) sorted.add(b);
        for (BItem b : bItems) if (b.qty == 0 && b.paired == 0) sorted.add(b);
        for (BItem b : bItems) {
            boxes += b.qty;
            paired += b.paired;
            if (b.expected != null) {
                expected++;
                if (b.qty > 0) started++;
            }
        }
        for (BItem b : sorted) {
            String line2 = (b.sku == null ? "" : b.sku + "   ")
                    + b.qty + (b.expected != null ? " / " + b.expected : "")
                    + " boxes · " + b.paired + " tags"
                    + (b == pairActive ? "   ◀ PAIRING" : "")
                    + (b.resolved ? "" : "   ⚠ unknown");
            rows.add(b.name() + "\n" + line2);
        }
        countView.setText(expected > 0
                ? boxes + " boxes · " + started + "/" + expected
                  + " products · " + paired + " tags"
                : boxes + " boxes · " + bItems.size() + " products · "
                  + paired + " tags");
        adapter.clear();
        adapter.addAll(rows);
    }

    private void batchScan(String code) {
        final boolean knownBefore;
        {
            boolean k = false;
            for (BItem b : bItems) {
                if ((b.barcode != null && b.barcode.equals(code))
                        || (b.sku != null && b.sku.equals(code))
                        || (!b.resolved && code.equals(b.barcode))) {
                    k = true;
                    break;
                }
            }
            knownBefore = k;
        }
        status.setText("Looking up " + code + "…");
        new Thread(() -> {
            try {
                JSONObject body = new JSONObject().put("code", code);
                JSONObject resp = api("POST",
                        "/api/batches/" + batchId + "/scan", body);
                final BItem item = BItem.from(resp.getJSONObject("item"));
                final boolean mismatch = resp.optBoolean("bin_mismatch");
                ui.post(() -> {
                    BItem existing = itemById(item.id);
                    boolean wasListed = existing != null || knownBefore;
                    if (existing != null) {
                        bItems.set(bItems.indexOf(existing), item);
                        if (pairActive == existing) pairActive = item;
                    } else {
                        bItems.add(0, item);
                    }
                    if (!item.resolved) {
                        beep(SOUND_ERR);
                        status.setText("UNKNOWN barcode " + code + " — "
                                + "counted (" + item.qty + "), resolve it "
                                + "at the Scan Station later.");
                    } else if (!wasListed) {
                        beep(SOUND_OTHER);
                        status.setText("Not expected in this bin (added): "
                                + item.name() + " — " + item.qty
                                + (mismatch ? "  · saved bin differs" : ""));
                    } else {
                        beep(SOUND_OK);
                        status.setText(item.name() + " — " + item.qty
                                + (item.expected != null
                                    ? " / " + item.expected : "")
                                + (mismatch ? "  · saved bin differs" : ""));
                    }
                    refreshBatchList();
                    btInput.requestFocus();
                });
            } catch (Exception e) {
                ui.post(() -> {
                    beep(SOUND_ERR);
                    status.setText("Scan failed: " + e.getMessage());
                    btInput.requestFocus();
                });
            }
        }).start();
    }

    private void pairSelect(String code) {
        BItem match = null;
        for (BItem b : bItems) {
            if (!b.resolved) continue;
            if ((b.barcode != null && b.barcode.equals(code))
                    || (b.sku != null && b.sku.equals(code))) {
                match = b;
                break;
            }
        }
        if (match == null) {
            // Brand serials: prefix match (e.g. Astronomik 4-digit prefixes).
            for (BItem b : bItems) {
                if (b.resolved && b.serialPrefix != null
                        && code.length() >= 4
                        && code.startsWith(b.serialPrefix)) {
                    match = b;
                    break;
                }
            }
        }
        if (match == null) {
            beep(SOUND_ERR);
            status.setText("\"" + code + "\" doesn't match a product in "
                    + "this batch.");
            return;
        }
        pairActive = match;
        beep(SOUND_OK);
        status.setText("PAIRING: " + match.name() + " — " + match.paired
                + " tag(s) so far. TRIGGER on each sticker.");
        refreshBatchList();
        btInput.requestFocus();
    }

    private void pairReadTag() {
        if (pairActive == null) {
            beep(SOUND_ERR);
            status.setText("Scan a product's barcode first — then trigger "
                    + "on its stickers.");
            return;
        }
        if (!readerReady) {
            beep(SOUND_ERR);
            status.setText("RFID reader not ready.");
            return;
        }
        if (tagReadBusy) return;
        tagReadBusy = true;
        status.setText("Reading tag… hold the antenna near ONE sticker");
        final BItem target = pairActive;
        new Thread(() -> {
            UHFTAGInfo info = null;
            try {
                if (scanning) {
                    reader.stopInventory();
                    scanning = false;
                }
                info = reader.inventorySingleTag();
            } catch (Exception ignored) {
            }
            final String epc = info == null ? null : info.getEPC();
            if (epc == null || epc.isEmpty()) {
                ui.post(() -> {
                    tagReadBusy = false;
                    beep(SOUND_ERR);
                    status.setText("No tag read — get closer to the sticker "
                            + "(power up if needed) and trigger again.");
                });
                return;
            }
            try {
                JSONObject body = new JSONObject()
                        .put("epc", epc)
                        .put("item_id", target.id)
                        .put("created_by", prefs.getString("device", "C72"));
                JSONObject resp = api("POST",
                        "/api/batches/" + batchId + "/pair", body);
                final BItem item = BItem.from(resp.getJSONObject("item"));
                final boolean suspect = resp.getJSONObject("assignment")
                        .optBoolean("suspect");
                ui.post(() -> {
                    tagReadBusy = false;
                    BItem existing = itemById(item.id);
                    if (existing != null) {
                        bItems.set(bItems.indexOf(existing), item);
                        if (pairActive == existing) pairActive = item;
                    }
                    pairHistory.push(new String[]{epc,
                            String.valueOf(item.id)});
                    beep(SOUND_OK);
                    status.setText((suspect ? "SUSPECT read saved — " : "")
                            + "Tag ✓ …" + epc.substring(
                                    Math.max(0, epc.length() - 6))
                            + " → " + item.name() + "  (" + item.paired
                            + (item.qty > 0 ? " / " + item.qty : "")
                            + " tags)");
                    refreshBatchList();
                });
            } catch (Exception e) {
                ui.post(() -> {
                    tagReadBusy = false;
                    beep(SOUND_ERR);
                    status.setText(e.getMessage());
                });
            }
        }).start();
    }

    private void undoPair() {
        final String[] last = pairHistory.peek();
        if (last == null) {
            status.setText("Nothing to undo.");
            return;
        }
        new Thread(() -> {
            try {
                JSONObject body = new JSONObject()
                        .put("epc", last[0])
                        .put("item_id", Integer.parseInt(last[1]));
                JSONObject resp = api("POST",
                        "/api/batches/" + batchId + "/pair/undo", body);
                final BItem item = BItem.from(resp.getJSONObject("item"));
                ui.post(() -> {
                    pairHistory.poll();
                    BItem existing = itemById(item.id);
                    if (existing != null) {
                        bItems.set(bItems.indexOf(existing), item);
                        if (pairActive == existing) pairActive = item;
                    }
                    beep(SOUND_OTHER);
                    status.setText("Undid tag …" + last[0].substring(
                            Math.max(0, last[0].length() - 6))
                            + " — " + item.name() + " now " + item.paired
                            + " tag(s).");
                    refreshBatchList();
                });
            } catch (Exception e) {
                ui.post(() -> status.setText("Undo failed: "
                        + e.getMessage()));
            }
        }).start();
    }

    private void finishBatch() {
        StringBuilder sb = new StringBuilder();
        int diffs = 0, unresolved = 0, unpaired = 0, lines = 0;
        for (BItem b : bItems) {
            if (!b.resolved) {
                if (b.qty > 0) unresolved++;
                continue;
            }
            if (b.qty == 0 && b.paired == 0) continue;
            if (b.paired < b.qty) unpaired++;
            String delta;
            if (b.expected != null && b.qty != b.expected) {
                int d = b.qty - b.expected;
                delta = b.expected + " → " + b.qty + " ("
                        + (d > 0 ? "+" + d : String.valueOf(d)) + ")";
                diffs++;
            } else {
                delta = b.qty + " ✓";
            }
            if (lines < 25) {
                sb.append(b.name()).append(":  ").append(delta).append("\n");
                lines++;
            }
        }
        if (lines == 0) sb.append("(no boxes scanned)\n");
        sb.append("\n");
        if (diffs > 0) sb.append(diffs).append(" count difference(s) will "
                + "be filed for Review.\n");
        if (unresolved > 0) sb.append(unresolved).append(" unknown "
                + "barcode(s) will be filed for Review.\n");
        if (unpaired > 0) sb.append(unpaired).append(" product(s) still "
                + "have unpaired boxes.\n");
        if (diffs + unresolved + unpaired == 0) {
            sb.append("Everything matches. Clean bin ✓\n");
        }
        sb.append("\nNo Shopify stock numbers change — differences go to "
                + "the Review tab for a decision.");
        new AlertDialog.Builder(this)
                .setTitle("Finish bin " + batchBin + "?")
                .setMessage(sb.toString())
                .setPositiveButton("Finish", (d, w) -> new Thread(() -> {
                    try {
                        JSONObject body = new JSONObject().put("created_by",
                                prefs.getString("device", "C72"));
                        JSONObject resp = api("POST", "/api/batches/"
                                + batchId + "/complete", body);
                        final int n = resp.getJSONArray("review_tasks")
                                .length();
                        ui.post(() -> {
                            beep(SOUND_OK);
                            Toast.makeText(this, "Batch done ✓",
                                    Toast.LENGTH_LONG).show();
                            exitBatch(true);
                            status.setText("Bin " + batchBin + " done — "
                                    + (n > 0 ? n + " follow-up(s) filed in "
                                       + "Review." : "no follow-ups. Pick "
                                       + "the next bin with BATCH…"));
                        });
                    } catch (Exception e) {
                        ui.post(() -> status.setText("Finish failed: "
                                + e.getMessage()));
                    }
                }).start())
                .setNegativeButton("Cancel", null)
                .show();
    }

    // -------------------------------------------------------------- UI -----
    private void refreshTick() {
        if (listDirty) {
            listDirty = false;
            if (!inBatch()) refreshList();
        }
        ui.postDelayed(this::refreshTick, 400);
    }

    private void refreshList() {
        if (inBatch()) {
            refreshBatchList();
            return;
        }
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
            status.setText("Sweep sending is RFID-mode only.");
            return;
        }
        final List<String> epcs = new ArrayList<>();
        synchronized (tags) { epcs.addAll(tags.keySet()); }
        if (epcs.isEmpty()) {
            Toast.makeText(this, "Nothing scanned yet", Toast.LENGTH_SHORT).show();
            return;
        }
        if (scanning) toggleScan();
        sendBtn.setEnabled(false);
        status.setText("Sending " + epcs.size() + " tags…");
        new Thread(() -> {
            String result;
            boolean ok = false;
            try {
                JSONObject body = new JSONObject();
                body.put("device", prefs.getString("device", "C72"));
                body.put("epcs", new JSONArray(epcs));
                JSONObject resp = api("POST", "/api/epc-captures", body);
                ok = true;
                result = "Sent ✓ sweep #" + resp.optInt("id") + " ("
                        + epcs.size() + " tags). Pull it on the PC's verify "
                        + "screen. CLEAR before the next shelf.";
            } catch (Exception e) {
                result = "Send FAILED (" + e.getMessage() + ") — tags kept "
                        + "on the device; get Wi-Fi coverage and press SEND "
                        + "again.";
            }
            final String msg = result;
            final boolean sent = ok;
            ui.post(() -> {
                status.setText(msg);
                sendBtn.setEnabled(!barcodeMode || inBatch());
                if (sent) Toast.makeText(this, "Sweep sent ✓",
                        Toast.LENGTH_LONG).show();
            });
        }).start();
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
