package com.telcan.rfidsweep;

// TC RFID Sweep — Chainway C72 companion app.
//
// v2.0: tabbed UI. BATCH (the shelf workflow), STATION (single-product
// tag linking), SWEEP (bulk RFID capture for verify), LOCATE (WIP).
// Tabs can be hidden in Settings. Power controls collapse into a "PWR n"
// chip that opens a dialog, so the working screen belongs to the scan
// list. Product previews show image + name + SKU with a scanned/expected
// tracker pinned to the card's corner.
//
// Barcodes come from the paired Bluetooth scanner (this unit has no
// built-in imager); it types into the capture box like a keyboard.
// The RFID trigger is SDK-driven — keep KeyboardEmulator's UHF mode off.

import android.app.Activity;
import android.app.AlertDialog;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
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
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ListView;
import android.widget.SeekBar;
import android.widget.TextView;
import android.widget.Toast;

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
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public class MainActivity extends Activity {

    private static final String DEFAULT_SERVER =
            "https://telcan-rfid.azurewebsites.net";
    private static final int[] TRIGGER_KEYS = {
            139, 280, 291, 293, 294, 311, 312, 313, 315, 591, 593, 594, 595, 596
    };
    private static final int[] PRESET_LEVELS = {2, 5, 10, 30};
    private static final String[] PRESET_LABELS = {
            "2 station", "5 bin", "10 rack", "30 locate"};

    private static final int SOUND_OK = 0;
    private static final int SOUND_OTHER = 1;
    private static final int SOUND_ERR = 2;

    private static final int TAB_BATCH = 0;
    private static final int TAB_STATION = 1;
    private static final int TAB_SWEEP = 2;
    private static final int TAB_LOCATE = 3;
    private static final String[] TAB_NAMES =
            {"BATCH", "STATION", "SWEEP", "LOCATE"};

    // ------------------------------------------------------------ colors ----
    private static final int C_BG = Color.parseColor("#f1f2f4");
    private static final int C_TEXT = Color.parseColor("#202223");
    private static final int C_MUTED = Color.parseColor("#6d7175");
    private static final int C_BLUE = Color.parseColor("#005bd3");
    private static final int C_CHIP = Color.parseColor("#d9dbdd");

    private RFIDWithUHFUART reader;
    private volatile boolean readerReady = false;
    private volatile boolean scanning = false;
    private volatile boolean listDirty = false;
    private volatile boolean tagReadBusy = false;

    private final Handler ui = new Handler(Looper.getMainLooper());
    private ToneGenerator tones;
    private SharedPreferences prefs;

    // ------------------------------------------------------------ widgets ---
    private final Button[] tabBtns = new Button[4];
    private int activeTab = TAB_BATCH;
    private EditText btInput;
    private TextView status;
    private final View[] tabViews = new View[4];

    // batch widgets
    private TextView binChip;
    private TextView phaseChip;
    private Button pwrChipBatch;
    private Button pickBtn;
    private FrameLayout batchCard;
    private ImageView batchImg;
    private TextView batchName;
    private TextView batchSku;
    private TextView batchTracker;
    private ListView batchListView;
    private ArrayAdapter<String> batchAdapter;
    private LinearLayout batchBtnRow;

    // station widgets
    private Button pwrChipStation;
    private FrameLayout stationCard;
    private ImageView stationImg;
    private TextView stationName;
    private TextView stationSku;
    private TextView stationTracker;
    private TextView stationHint;

    // sweep widgets
    private TextView sweepCount;
    private Button sweepToggle;
    private ArrayAdapter<String> sweepAdapter;

    // ------------------------------------------------------------- state ----
    private static class BItem {
        int id;
        String title = "";
        String variant;
        String sku;
        String barcode;
        String serialPrefix;
        String imageUrl;
        boolean resolved;
        int qty;
        Integer expected;
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
            b.imageUrl = o.isNull("image_url") ? null
                    : o.optString("image_url");
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
    private BItem previewItem = null;   // last scanned / pair target
    private BItem pairActive = null;
    private final ArrayDeque<String[]> pairHistory = new ArrayDeque<>();

    private JSONObject stationProduct = null;
    private int stationTags = 0;
    private final ArrayDeque<String> stationHistory = new ArrayDeque<>();

    private final LinkedHashMap<String, Integer> tags = new LinkedHashMap<>();

    private final HashMap<String, Bitmap> imgCache = new HashMap<>();

    // ============================================================ onCreate ==
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
        int pad = dp(8);
        root.setPadding(pad, pad, pad, pad);
        root.setBackgroundColor(C_BG);

        // ---- tab row -------------------------------------------------------
        LinearLayout tabRow = new LinearLayout(this);
        for (int i = 0; i < 4; i++) {
            final int tab = i;
            Button b = smallBtn(TAB_NAMES[i]);
            b.setOnClickListener(v -> selectTab(tab));
            tabBtns[i] = b;
            tabRow.addView(b, weight());
        }
        Button gear = smallBtn("⚙");
        gear.setOnClickListener(v -> showSettings());
        tabRow.addView(gear, new LinearLayout.LayoutParams(dp(40),
                LinearLayout.LayoutParams.WRAP_CONTENT));
        root.addView(tabRow);

        // ---- shared scanner input + status --------------------------------
        btInput = new EditText(this);
        btInput.setHint("BT scanner…");
        btInput.setTextSize(13);
        btInput.setPadding(dp(8), dp(4), dp(8), dp(4));
        btInput.setInputType(InputType.TYPE_CLASS_TEXT
                | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
        btInput.setShowSoftInputOnFocus(false);
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

        status = new TextView(this);
        status.setTextSize(13);
        status.setTextColor(C_MUTED);
        status.setPadding(dp(2), dp(2), dp(2), dp(4));
        status.setMaxLines(3);
        root.addView(status);

        // ---- content -------------------------------------------------------
        FrameLayout content = new FrameLayout(this);
        tabViews[TAB_BATCH] = buildBatchView();
        tabViews[TAB_STATION] = buildStationView();
        tabViews[TAB_SWEEP] = buildSweepView();
        tabViews[TAB_LOCATE] = buildLocateView();
        for (View v : tabViews) content.addView(v);
        root.addView(content, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f));

        setContentView(root);

        restoreMap("saved_tags", tags);
        selectTab(TAB_BATCH);
        initReader();
        ui.postDelayed(this::refreshTick, 400);
    }

    // ------------------------------------------------------- view builders --
    private View buildBatchView() {
        LinearLayout v = new LinearLayout(this);
        v.setOrientation(LinearLayout.VERTICAL);

        LinearLayout header = new LinearLayout(this);
        header.setGravity(Gravity.CENTER_VERTICAL);
        binChip = new TextView(this);
        binChip.setTextSize(17);
        binChip.setTypeface(null, Typeface.BOLD);
        binChip.setTextColor(C_TEXT);
        header.addView(binChip, weight());
        pwrChipBatch = chipBtn("PWR " + prefs.getInt("power", 5));
        pwrChipBatch.setOnClickListener(x -> showPowerDialog());
        header.addView(pwrChipBatch);
        phaseChip = new TextView(this);
        phaseChip.setTextSize(15);
        phaseChip.setTypeface(null, Typeface.BOLD);
        phaseChip.setTextColor(Color.WHITE);
        phaseChip.setBackgroundColor(C_BLUE);
        phaseChip.setPadding(dp(10), dp(4), dp(10), dp(4));
        phaseChip.setOnClickListener(x -> togglePhase());
        LinearLayout.LayoutParams pcl = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT);
        pcl.leftMargin = dp(6);
        header.addView(phaseChip, pcl);
        v.addView(header);

        pickBtn = new Button(this);
        pickBtn.setText("PICK OPEN BATCH…");
        pickBtn.setOnClickListener(x -> openBatchPicker());
        v.addView(pickBtn);

        batchCard = new FrameLayout(this);
        ImageView[] img = new ImageView[1];
        TextView[] nm = new TextView[1], sk = new TextView[1], tr = new TextView[1];
        buildCard(batchCard, img, nm, sk, tr);
        batchImg = img[0];
        batchName = nm[0];
        batchSku = sk[0];
        batchTracker = tr[0];
        batchCard.setVisibility(View.GONE);
        v.addView(batchCard);

        batchListView = new ListView(this);
        batchAdapter = new ArrayAdapter<>(this,
                android.R.layout.simple_list_item_1);
        batchListView.setAdapter(batchAdapter);
        v.addView(batchListView, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f));

        batchBtnRow = new LinearLayout(this);
        Button undo = smallBtn("UNDO");
        undo.setOnClickListener(x -> undoPair());
        batchBtnRow.addView(undo, weight());
        Button finish = smallBtn("FINISH");
        finish.setOnClickListener(x -> finishBatch());
        batchBtnRow.addView(finish, weight());
        Button exit = smallBtn("EXIT");
        exit.setOnClickListener(x -> exitBatch(false));
        batchBtnRow.addView(exit, weight());
        v.addView(batchBtnRow);

        return v;
    }

    private View buildStationView() {
        LinearLayout v = new LinearLayout(this);
        v.setOrientation(LinearLayout.VERTICAL);

        LinearLayout header = new LinearLayout(this);
        header.setGravity(Gravity.CENTER_VERTICAL);
        TextView t = new TextView(this);
        t.setText("Scan station");
        t.setTextSize(17);
        t.setTypeface(null, Typeface.BOLD);
        t.setTextColor(C_TEXT);
        header.addView(t, weight());
        pwrChipStation = chipBtn("PWR " + prefs.getInt("power", 5));
        pwrChipStation.setOnClickListener(x -> showPowerDialog());
        header.addView(pwrChipStation);
        v.addView(header);

        stationCard = new FrameLayout(this);
        ImageView[] img = new ImageView[1];
        TextView[] nm = new TextView[1], sk = new TextView[1], tr = new TextView[1];
        buildCard(stationCard, img, nm, sk, tr);
        stationImg = img[0];
        stationName = nm[0];
        stationSku = sk[0];
        stationTracker = tr[0];
        stationCard.setVisibility(View.GONE);
        v.addView(stationCard);

        stationHint = new TextView(this);
        stationHint.setTextColor(C_MUTED);
        stationHint.setTextSize(14);
        stationHint.setPadding(dp(4), dp(10), dp(4), 0);
        stationHint.setText("Scan a product barcode, then pull the TRIGGER "
                + "on the RFID sticker to link it.\n\nEach trigger pull "
                + "links one more tag to the shown product.");
        v.addView(stationHint, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f));

        Button unlink = smallBtn("UNLINK LAST TAG");
        unlink.setOnClickListener(x -> stationUnlink());
        v.addView(unlink);
        return v;
    }

    private View buildSweepView() {
        LinearLayout v = new LinearLayout(this);
        v.setOrientation(LinearLayout.VERTICAL);

        LinearLayout header = new LinearLayout(this);
        header.setGravity(Gravity.CENTER_VERTICAL);
        sweepCount = new TextView(this);
        sweepCount.setText("0 unique tags");
        sweepCount.setTextSize(22);
        sweepCount.setTypeface(null, Typeface.BOLD);
        sweepCount.setTextColor(C_BLUE);
        header.addView(sweepCount, weight());
        Button pwr = chipBtn("PWR " + prefs.getInt("power", 5));
        pwr.setOnClickListener(x -> showPowerDialog());
        header.addView(pwr);
        v.addView(header);

        LinearLayout row = new LinearLayout(this);
        sweepToggle = smallBtn("START SCAN");
        sweepToggle.setOnClickListener(x -> toggleScan());
        row.addView(sweepToggle, weight());
        Button send = smallBtn("SEND SWEEP");
        send.setOnClickListener(x -> sendSweep());
        row.addView(send, weight());
        Button clear = smallBtn("CLEAR");
        clear.setOnClickListener(x -> confirmClearSweep());
        row.addView(clear, weight());
        v.addView(row);

        ListView list = new ListView(this);
        sweepAdapter = new ArrayAdapter<>(this,
                android.R.layout.simple_list_item_1);
        list.setAdapter(sweepAdapter);
        v.addView(list, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f));
        return v;
    }

    private View buildLocateView() {
        LinearLayout v = new LinearLayout(this);
        v.setOrientation(LinearLayout.VERTICAL);
        v.setGravity(Gravity.CENTER);
        TextView t = new TextView(this);
        t.setGravity(Gravity.CENTER);
        t.setTextColor(C_MUTED);
        t.setTextSize(16);
        t.setText("LOCATE — coming soon.\n\nScan or pick a product, crank "
                + "power to 30, and the C72 will geiger-beep hotter as you "
                + "close in on its tag.");
        v.addView(t);
        return v;
    }

    // Preview card: [image | name + SKU] with the tracker pinned top-right.
    private void buildCard(FrameLayout card, ImageView[] img, TextView[] name,
                           TextView[] sku, TextView[] tracker) {
        card.setBackgroundColor(Color.WHITE);
        card.setPadding(dp(8), dp(8), dp(8), dp(8));

        LinearLayout row = new LinearLayout(this);
        row.setGravity(Gravity.CENTER_VERTICAL);
        ImageView iv = new ImageView(this);
        iv.setScaleType(ImageView.ScaleType.CENTER_CROP);
        iv.setBackgroundColor(C_BG);
        LinearLayout.LayoutParams il =
                new LinearLayout.LayoutParams(dp(64), dp(64));
        il.rightMargin = dp(8);
        row.addView(iv, il);

        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        TextView nm = new TextView(this);
        nm.setTextSize(15);
        nm.setTypeface(null, Typeface.BOLD);
        nm.setTextColor(C_TEXT);
        nm.setMaxLines(2);
        // keep the name clear of the corner tracker
        nm.setPadding(0, 0, dp(52), 0);
        col.addView(nm);
        TextView sk = new TextView(this);
        sk.setTextSize(13);
        sk.setTextColor(C_MUTED);
        col.addView(sk);
        row.addView(col, weight());
        card.addView(row);

        TextView tr = new TextView(this);
        tr.setTextSize(19);
        tr.setTypeface(null, Typeface.BOLD);
        tr.setTextColor(C_BLUE);
        FrameLayout.LayoutParams tl = new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.WRAP_CONTENT,
                FrameLayout.LayoutParams.WRAP_CONTENT,
                Gravity.TOP | Gravity.END);
        tl.topMargin = dp(2);
        tl.rightMargin = dp(4);
        card.addView(tr, tl);

        img[0] = iv;
        name[0] = nm;
        sku[0] = sk;
        tracker[0] = tr;
    }

    private Button smallBtn(String text) {
        Button b = new Button(this);
        b.setText(text);
        b.setTextSize(12);
        b.setAllCaps(false);
        b.setMinHeight(0);
        b.setMinimumHeight(dp(38));
        b.setPadding(dp(4), 0, dp(4), 0);
        return b;
    }

    private Button chipBtn(String text) {
        Button b = smallBtn(text);
        b.setBackgroundColor(C_CHIP);
        b.setMinimumHeight(dp(32));
        return b;
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

    // ------------------------------------------------------------- tabs -----
    private void selectTab(int tab) {
        activeTab = tab;
        for (int i = 0; i < 4; i++) {
            boolean shown = tabVisible(i);
            tabBtns[i].setVisibility(shown ? View.VISIBLE : View.GONE);
            tabBtns[i].setBackgroundColor(i == tab ? C_BLUE : C_CHIP);
            tabBtns[i].setTextColor(i == tab ? Color.WHITE : C_TEXT);
            tabViews[i].setVisibility(i == tab ? View.VISIBLE : View.GONE);
        }
        boolean needsInput = tab == TAB_BATCH || tab == TAB_STATION;
        btInput.setVisibility(needsInput ? View.VISIBLE : View.GONE);
        if (needsInput) btInput.requestFocus();
        if (tab == TAB_BATCH) {
            applyBatchUi();
        } else if (tab == TAB_STATION) {
            status.setText(stationProduct == null
                    ? "Scan a product barcode."
                    : "Trigger to link tags to the shown product.");
        } else if (tab == TAB_SWEEP) {
            refreshSweepList();
            status.setText("Trigger or START to sweep tags; SEND when done.");
        } else {
            status.setText("Locate is not built yet.");
        }
    }

    private boolean tabVisible(int tab) {
        if (tab == TAB_BATCH) return true;
        String key = tab == TAB_STATION ? "tab_station"
                : tab == TAB_SWEEP ? "tab_sweep" : "tab_locate";
        return prefs.getBoolean(key, true);
    }

    // Every barcode from the BT scanner funnels through here.
    private void onScanInput(String code) {
        if (activeTab == TAB_BATCH) {
            if (!inBatch()) {
                beep(SOUND_ERR);
                status.setText("Pick a batch first.");
                return;
            }
            if (pairPhase) pairSelect(code);
            else batchScan(code);
        } else if (activeTab == TAB_STATION) {
            stationLookup(code);
        } else {
            status.setText("Scanned " + code + " — switch to BATCH or "
                    + "STATION to use barcodes.");
        }
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        for (int k : TRIGGER_KEYS) {
            if (keyCode == k) {
                if (event.getRepeatCount() == 0) onTrigger();
                return true;
            }
        }
        return super.onKeyDown(keyCode, event);
    }

    private void onTrigger() {
        if (activeTab == TAB_BATCH) {
            if (inBatch() && pairPhase) {
                pairReadTag();
            } else if (inBatch()) {
                beep(SOUND_ERR);
                status.setText("COLLECT uses the barcode scanner — tap the "
                        + "COLLECT chip to switch to PAIR for stickers.");
            } else {
                status.setText("Pick a batch first.");
            }
        } else if (activeTab == TAB_STATION) {
            stationReadTag();
        } else if (activeTab == TAB_SWEEP) {
            toggleScan();
        } else {
            status.setText("Locate is not built yet.");
        }
    }

    // ------------------------------------------------------------ images ----
    private void loadImage(String url, ImageView into) {
        if (url == null || url.isEmpty()) {
            into.setImageBitmap(null);
            return;
        }
        Bitmap cached = imgCache.get(url);
        if (cached != null) {
            into.setImageBitmap(cached);
            return;
        }
        into.setImageBitmap(null);
        into.setTag(url);
        new Thread(() -> {
            try {
                HttpURLConnection conn = (HttpURLConnection)
                        new URL(url).openConnection();
                conn.setConnectTimeout(8000);
                conn.setReadTimeout(15000);
                Bitmap bmp = BitmapFactory.decodeStream(conn.getInputStream());
                conn.disconnect();
                if (bmp != null) {
                    ui.post(() -> {
                        imgCache.put(url, bmp);
                        if (url.equals(into.getTag())) into.setImageBitmap(bmp);
                    });
                }
            } catch (Exception ignored) {
            }
        }).start();
    }

    // -------------------------------------------------------------- RFID ----
    private void initReader() {
        status.setText("Starting the RFID reader…");
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
                status.setText(ready
                        ? "Ready (power " + power + ")."
                        : "RFID reader init FAILED — turn off "
                          + "KeyboardEmulator's UHF mode and reopen.");
            });
        }).start();
    }

    private void setPowerLevel(int level) {
        final int lv = Math.max(1, Math.min(30, level));
        prefs.edit().putInt("power", lv).apply();
        updatePowerChips(lv);
        if (!readerReady) return;
        final boolean wasScanning = scanning;
        new Thread(() -> {
            try {
                if (wasScanning) reader.stopInventory();
                final boolean ok = reader.setPower(lv);
                if (wasScanning) reader.startInventoryTag();
                ui.post(() -> status.setText(ok
                        ? "Power set to " + lv
                        : "Power change FAILED — try again"));
            } catch (Exception e) {
                ui.post(() -> status.setText("Power change failed: "
                        + e.getMessage()));
            }
        }).start();
    }

    private void updatePowerChips(int lv) {
        pwrChipBatch.setText("PWR " + lv);
        pwrChipStation.setText("PWR " + lv);
    }

    private void showPowerDialog() {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        int pad = dp(16);
        box.setPadding(pad, pad, pad, 0);

        final TextView label = new TextView(this);
        int cur = prefs.getInt("power", 5);
        label.setText("RFID power: " + cur);
        label.setTypeface(null, Typeface.BOLD);
        box.addView(label);

        final SeekBar seek = new SeekBar(this);
        seek.setMax(29);
        seek.setProgress(cur - 1);
        seek.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            @Override
            public void onProgressChanged(SeekBar s, int p, boolean u) {
                label.setText("RFID power: " + (p + 1));
            }

            @Override
            public void onStartTrackingTouch(SeekBar s) {
            }

            @Override
            public void onStopTrackingTouch(SeekBar s) {
                setPowerLevel(s.getProgress() + 1);
            }
        });
        box.addView(seek);

        LinearLayout presets = new LinearLayout(this);
        for (int i = 0; i < PRESET_LEVELS.length; i++) {
            final int level = PRESET_LEVELS[i];
            Button b = smallBtn(PRESET_LABELS[i]);
            b.setOnClickListener(x -> {
                seek.setProgress(level - 1);
                setPowerLevel(level);
            });
            presets.addView(b, weight());
        }
        box.addView(presets);

        new AlertDialog.Builder(this)
                .setTitle("Scanner power")
                .setView(box)
                .setPositiveButton("Done", null)
                .show();
    }

    // -------------------------------------------------------------- HTTP ----
    private JSONObject api(String method, String path, JSONObject body)
            throws Exception {
        String server = prefs.getString("server", DEFAULT_SERVER)
                .replaceAll("/+$", "");
        String key = prefs.getString("key", "");
        if (key.isEmpty()) {
            throw new Exception("Station key not set — open ⚙ and paste "
                    + "your station link.");
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

    // ------------------------------------------------------------- batch ----
    private boolean inBatch() {
        return batchId >= 0;
    }

    private void togglePhase() {
        if (!inBatch()) {
            openBatchPicker();
            return;
        }
        pairPhase = !pairPhase;
        pairActive = null;
        applyBatchUi();
    }

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
                    previewItem = null;
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
        boolean in = inBatch();
        binChip.setText(in ? "Bin " + batchBin : "No batch");
        phaseChip.setText(in ? (pairPhase ? "PAIR" : "COLLECT") : "PICK");
        pickBtn.setVisibility(in ? View.GONE : View.VISIBLE);
        batchBtnRow.setVisibility(in ? View.VISIBLE : View.GONE);
        if (in) {
            status.setText(pairPhase
                    ? "PAIR: scan a product barcode, then TRIGGER each of "
                      + "its stickers."
                    : "COLLECT: scan every box in this bin.");
        } else {
            status.setText("Pick an open batch (started on the PC/iPad).");
            batchCard.setVisibility(View.GONE);
        }
        updateBatchCard();
        refreshBatchList();
        if (activeTab == TAB_BATCH) btInput.requestFocus();
    }

    private void updateBatchCard() {
        BItem it = pairPhase && pairActive != null ? pairActive : previewItem;
        if (it == null) {
            batchCard.setVisibility(View.GONE);
            return;
        }
        batchCard.setVisibility(View.VISIBLE);
        batchName.setText(it.name());
        batchSku.setText((it.sku == null ? "no SKU" : it.sku)
                + (pairPhase ? "  ·  " + it.paired + " tag(s)" : ""));
        batchTracker.setText(it.expected != null
                ? it.qty + "/" + it.expected : String.valueOf(it.qty));
        loadImage(it.imageUrl, batchImg);
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
                    + b.qty + (b.expected != null ? "/" + b.expected : "")
                    + " boxes · " + b.paired + " tags"
                    + (b == pairActive ? "   ◀ PAIRING" : "")
                    + (b.resolved ? "" : "   ⚠ unknown");
            rows.add(b.name() + "\n" + line2);
        }
        if (inBatch()) {
            binChip.setText("Bin " + batchBin + "  ·  " + boxes + " boxes"
                    + (expected > 0 ? " · " + started + "/" + expected : ""));
        }
        batchAdapter.clear();
        batchAdapter.addAll(rows);
    }

    private void batchScan(String code) {
        final boolean knownBefore;
        {
            boolean k = false;
            for (BItem b : bItems) {
                if ((b.barcode != null && b.barcode.equals(code))
                        || (b.sku != null && b.sku.equals(code))) {
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
                    previewItem = item;
                    if (!item.resolved) {
                        beep(SOUND_ERR);
                        status.setText("UNKNOWN barcode " + code + " — "
                                + "counted (" + item.qty + "), resolve it "
                                + "at the Scan Station later.");
                    } else if (!wasListed) {
                        beep(SOUND_OTHER);
                        status.setText("Not expected in this bin (added)"
                                + (mismatch ? " · saved bin differs" : ""));
                    } else {
                        beep(SOUND_OK);
                        status.setText(mismatch
                                ? "Counted · saved bin differs" : "Counted.");
                    }
                    updateBatchCard();
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
        previewItem = match;
        beep(SOUND_OK);
        status.setText("TRIGGER on each sticker for this product.");
        updateBatchCard();
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
                    status.setText("No tag read — get closer (or raise "
                            + "PWR) and trigger again.");
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
                        if (previewItem == existing) previewItem = item;
                    }
                    pairHistory.push(new String[]{epc,
                            String.valueOf(item.id)});
                    beep(SOUND_OK);
                    status.setText((suspect ? "SUSPECT read saved — " : "")
                            + "Tag ✓ …" + epc.substring(
                                    Math.max(0, epc.length() - 6))
                            + "  (" + item.paired
                            + (item.qty > 0 ? "/" + item.qty : "")
                            + " tags)");
                    updateBatchCard();
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
                        if (previewItem == existing) previewItem = item;
                    }
                    beep(SOUND_OTHER);
                    status.setText("Undid tag …" + last[0].substring(
                            Math.max(0, last[0].length() - 6))
                            + " — now " + item.paired + " tag(s).");
                    updateBatchCard();
                    refreshBatchList();
                });
            } catch (Exception e) {
                ui.post(() -> status.setText("Undo failed: "
                        + e.getMessage()));
            }
        }).start();
    }

    private void exitBatch(boolean completed) {
        batchId = -1;
        batchBin = null;
        bItems.clear();
        pairActive = null;
        previewItem = null;
        pairHistory.clear();
        pairPhase = false;
        applyBatchUi();
        if (!completed) {
            status.setText("Left the batch (still open — resume any time).");
        }
    }

    private void finishBatch() {
        if (!inBatch()) return;
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
                        final String bin = batchBin;
                        ui.post(() -> {
                            beep(SOUND_OK);
                            Toast.makeText(this, "Batch done ✓",
                                    Toast.LENGTH_LONG).show();
                            exitBatch(true);
                            status.setText("Bin " + bin + " done — "
                                    + (n > 0 ? n + " follow-up(s) filed in "
                                       + "Review." : "no follow-ups ✓"));
                        });
                    } catch (Exception e) {
                        ui.post(() -> status.setText("Finish failed: "
                                + e.getMessage()));
                    }
                }).start())
                .setNegativeButton("Cancel", null)
                .show();
    }

    // ------------------------------------------------------------ station ---
    private void stationLookup(String code) {
        status.setText("Looking up " + code + "…");
        new Thread(() -> {
            try {
                String enc = URLEncoder.encode(code, "UTF-8");
                JSONObject prod = api("GET",
                        "/api/products/by-barcode/" + enc, null);
                int count = 0;
                try {
                    String q = prod.isNull("sku")
                            ? "barcode=" + URLEncoder.encode(
                                    prod.optString("barcode", code), "UTF-8")
                            : "sku=" + URLEncoder.encode(
                                    prod.optString("sku"), "UTF-8");
                    count = api("GET", "/api/products/tags?" + q, null)
                            .optInt("count");
                } catch (Exception ignored) {
                }
                final JSONObject p = prod;
                final int tagsOnFile = count;
                ui.post(() -> {
                    stationProduct = p;
                    stationTags = tagsOnFile;
                    stationCard.setVisibility(View.VISIBLE);
                    String name = p.optString("product_title", "(unknown)");
                    String variant = p.isNull("variant_title") ? null
                            : p.optString("variant_title");
                    if (variant != null && !variant.isEmpty()) {
                        name += " (" + variant + ")";
                    }
                    stationName.setText(name);
                    stationSku.setText((p.isNull("sku") ? "no SKU"
                            : p.optString("sku"))
                            + "  ·  bin " + p.optString("bin_location", "—"));
                    stationTracker.setText(String.valueOf(tagsOnFile));
                    loadImage(p.isNull("image_url") ? null
                            : p.optString("image_url"), stationImg);
                    beep(SOUND_OK);
                    status.setText("Trigger on the sticker to link it "
                            + "(" + tagsOnFile + " tag(s) on file).");
                    btInput.requestFocus();
                });
            } catch (Exception e) {
                ui.post(() -> {
                    beep(SOUND_ERR);
                    status.setText("No product for \"" + code + "\" — "
                            + e.getMessage());
                    btInput.requestFocus();
                });
            }
        }).start();
    }

    private void stationReadTag() {
        if (stationProduct == null) {
            beep(SOUND_ERR);
            status.setText("Scan a product barcode first.");
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
        final JSONObject p = stationProduct;
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
                    status.setText("No tag read — get closer and trigger "
                            + "again.");
                });
                return;
            }
            try {
                JSONObject body = new JSONObject()
                        .put("rfid_id", epc)
                        .put("shopify_variant_id",
                                p.optString("shopify_variant_id"))
                        .put("shopify_product_id",
                                p.isNull("shopify_product_id") ? JSONObject.NULL
                                        : p.optString("shopify_product_id"))
                        .put("product_title",
                                p.optString("product_title", "(unknown)"))
                        .put("variant_title",
                                p.isNull("variant_title") ? JSONObject.NULL
                                        : p.optString("variant_title"))
                        .put("sku", p.isNull("sku") ? JSONObject.NULL
                                : p.optString("sku"))
                        .put("barcode", p.isNull("barcode") ? JSONObject.NULL
                                : p.optString("barcode"))
                        .put("bin_location",
                                p.isNull("bin_location") ? JSONObject.NULL
                                        : p.optString("bin_location"))
                        .put("assigned_by",
                                prefs.getString("device", "C72"));
                JSONObject resp = api("POST", "/api/rfid-assignments", body);
                final boolean suspect = resp.optBoolean("suspect");
                ui.post(() -> {
                    tagReadBusy = false;
                    stationTags++;
                    stationHistory.push(epc);
                    stationTracker.setText(String.valueOf(stationTags));
                    beep(SOUND_OK);
                    status.setText((suspect ? "SUSPECT read saved — " : "")
                            + "Linked ✓ …" + epc.substring(
                                    Math.max(0, epc.length() - 6))
                            + "  (" + stationTags + " on file)");
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

    private void stationUnlink() {
        final String last = stationHistory.peek();
        if (last == null) {
            status.setText("No tag linked this session.");
            return;
        }
        new Thread(() -> {
            try {
                api("DELETE", "/api/rfid-assignments/"
                        + URLEncoder.encode(last, "UTF-8"), null);
                ui.post(() -> {
                    stationHistory.poll();
                    stationTags = Math.max(0, stationTags - 1);
                    stationTracker.setText(String.valueOf(stationTags));
                    beep(SOUND_OTHER);
                    status.setText("Unlinked …" + last.substring(
                            Math.max(0, last.length() - 6)) + ".");
                });
            } catch (Exception e) {
                ui.post(() -> status.setText("Unlink failed: "
                        + e.getMessage()));
            }
        }).start();
    }

    // -------------------------------------------------------------- sweep ---
    private void toggleScan() {
        if (!readerReady) {
            Toast.makeText(this, "Reader not ready", Toast.LENGTH_SHORT).show();
            return;
        }
        if (scanning) {
            reader.stopInventory();
            scanning = false;
            sweepToggle.setText("START SCAN");
            status.setText("Paused — SEND when the shelf is done.");
        } else if (reader.startInventoryTag()) {
            scanning = true;
            sweepToggle.setText("STOP SCAN");
            status.setText("Sweeping… walk the shelf.");
        } else {
            status.setText("Could not start the scan — try again.");
        }
    }

    private void refreshSweepList() {
        List<String> rows = new ArrayList<>();
        synchronized (tags) {
            sweepCount.setText(tags.size() + " unique tags");
            for (Map.Entry<String, Integer> e : tags.entrySet()) {
                rows.add(e.getKey() + "   ×" + e.getValue());
            }
        }
        sweepAdapter.clear();
        sweepAdapter.addAll(rows);
    }

    private void confirmClearSweep() {
        int n;
        synchronized (tags) { n = tags.size(); }
        if (n == 0) return;
        new AlertDialog.Builder(this)
                .setMessage("Clear " + n + " collected tags?")
                .setPositiveButton("Clear", (d, w) -> {
                    synchronized (tags) { tags.clear(); }
                    refreshSweepList();
                    status.setText("Cleared — ready for the next shelf.");
                })
                .setNegativeButton("Cancel", null)
                .show();
    }

    private void sendSweep() {
        final List<String> epcs = new ArrayList<>();
        synchronized (tags) { epcs.addAll(tags.keySet()); }
        if (epcs.isEmpty()) {
            Toast.makeText(this, "Nothing scanned yet", Toast.LENGTH_SHORT).show();
            return;
        }
        if (scanning) toggleScan();
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
                result = "Send FAILED (" + e.getMessage() + ") — tags kept; "
                        + "get Wi-Fi coverage and press SEND again.";
            }
            final String msg = result;
            final boolean sent = ok;
            ui.post(() -> {
                status.setText(msg);
                if (sent) Toast.makeText(this, "Sweep sent ✓",
                        Toast.LENGTH_LONG).show();
            });
        }).start();
    }

    // -------------------------------------------------------------- UI ------
    private void refreshTick() {
        if (listDirty) {
            listDirty = false;
            if (activeTab == TAB_SWEEP) refreshSweepList();
        }
        ui.postDelayed(this::refreshTick, 400);
    }

    // --------------------------------------------------------- settings -----
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

        TextView tabsLabel = new TextView(this);
        tabsLabel.setText("Visible tabs (BATCH always shows):");
        tabsLabel.setPadding(0, dp(10), 0, 0);
        box.addView(tabsLabel);
        final CheckBox cbStation = new CheckBox(this);
        cbStation.setText("Station");
        cbStation.setChecked(prefs.getBoolean("tab_station", true));
        box.addView(cbStation);
        final CheckBox cbSweep = new CheckBox(this);
        cbSweep.setText("Sweep");
        cbSweep.setChecked(prefs.getBoolean("tab_sweep", true));
        box.addView(cbSweep);
        final CheckBox cbLocate = new CheckBox(this);
        cbLocate.setText("Locate (WIP)");
        cbLocate.setChecked(prefs.getBoolean("tab_locate", true));
        box.addView(cbLocate);

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
                            .putBoolean("tab_station", cbStation.isChecked())
                            .putBoolean("tab_sweep", cbSweep.isChecked())
                            .putBoolean("tab_locate", cbLocate.isChecked())
                            .apply();
                    if (!tabVisible(activeTab)) activeTab = TAB_BATCH;
                    selectTab(activeTab);
                    status.setText(key.isEmpty()
                            ? "Saved — but the station key is still empty"
                            : "Settings saved ✓");
                })
                .setNegativeButton("Cancel", null)
                .show();
    }

    // ------------------------------------------------------- persistence ----
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
            if (tones != null) tones.release();
        } catch (Exception ignored) {
        }
    }
}
