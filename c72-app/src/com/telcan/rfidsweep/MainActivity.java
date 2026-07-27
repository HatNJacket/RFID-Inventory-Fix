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
import android.view.ViewGroup;
import android.view.WindowManager;
import android.widget.ArrayAdapter;
import android.widget.BaseAdapter;
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
    private static final int TAB_FIND = 3;
    private static final int TAB_LOCATE = 4;
    private static final String[] TAB_NAMES =
            {"BATCH", "STATION", "SWEEP", "FIND BIN", "LOCATE"};
    private static final int TAB_COUNT = 5;

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
    private final Button[] tabBtns = new Button[TAB_COUNT];
    private Button gearBtn;
    private FrameLayout drawerScrim;
    private LinearLayout drawerPanel;
    private TextView tabTitle;
    private int activeTab = TAB_BATCH;
    private EditText btInput;
    private TextView status;
    private final View[] tabViews = new View[TAB_COUNT];

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
    private BatchAdapter batchAdapter;
    private final List<BItem> displayItems = new ArrayList<>();
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
        String scannedCode;
        String serialPrefix;
        String imageUrl;
        String variantId;
        String binLocation;
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
            b.scannedCode = o.isNull("scanned_code") ? null
                    : o.optString("scanned_code");
            b.serialPrefix = o.isNull("serial_prefix") ? null
                    : o.optString("serial_prefix");
            b.imageUrl = o.isNull("image_url") ? null
                    : o.optString("image_url");
            b.variantId = o.isNull("shopify_variant_id") ? null
                    : o.optString("shopify_variant_id");
            b.binLocation = o.isNull("bin_location") ? null
                    : o.optString("bin_location");
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

    private static final int STEP_COLLECT = 0;
    private static final int STEP_CHECK = 1;
    private static final int STEP_PAIR = 2;
    private static final String[] STEP_NAMES = {"COLLECT", "CHECK", "PAIR"};

    private static class CheckEntry {
        BItem item;
        final List<String> flags = new ArrayList<>();
        final List<JSONObject> candidates = new ArrayList<>();
    }

    private int batchId = -1;
    private String batchBin = null;
    private int step = STEP_COLLECT;
    private final List<BItem> bItems = new ArrayList<>();
    private final List<CheckEntry> checkEntries = new ArrayList<>();
    private final HashMap<Integer, String> checkFlagText = new HashMap<>();
    private BItem previewItem = null;   // last scanned / pair target
    private BItem pairActive = null;
    private final ArrayDeque<String[]> pairHistory = new ArrayDeque<>();

    // check-item editor state
    private CheckEntry editEntry = null;
    private int editIdx = 0;
    // wrong-bin warnings dismissed for this batch only
    private final java.util.Set<Integer> ignoredBins = new java.util.HashSet<>();

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
        // Alarm stream: audible regardless of the device's media volume —
        // field testing showed STREAM_MUSIC tones can be silently muted.
        try {
            tones = new ToneGenerator(AudioManager.STREAM_ALARM, 100);
        } catch (Exception ignored) {
        }

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        int pad = dp(8);
        root.setPadding(pad, pad, pad, pad);
        root.setBackgroundColor(C_BG);

        // ---- header: drawer button + scanner input / tab title -------------
        // Tabs live in a slide-in drawer OVER the content (scrim behind),
        // so the working screen never gives up layout space.
        LinearLayout header = new LinearLayout(this);
        header.setGravity(Gravity.CENTER_VERTICAL);
        Button menuBtn = smallBtn("≡");
        menuBtn.setOnClickListener(v -> toggleDrawer());
        header.addView(menuBtn, new LinearLayout.LayoutParams(dp(44),
                LinearLayout.LayoutParams.WRAP_CONTENT));

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
        header.addView(btInput, weight());

        // Shown in place of the input on tabs that don't take barcodes.
        tabTitle = new TextView(this);
        tabTitle.setTextSize(16);
        tabTitle.setTypeface(null, Typeface.BOLD);
        tabTitle.setTextColor(C_TEXT);
        tabTitle.setPadding(dp(6), 0, 0, 0);
        header.addView(tabTitle, weight());
        root.addView(header);

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
        tabViews[TAB_FIND] = buildFindView();
        tabViews[TAB_LOCATE] = buildLocateView();
        for (View v : tabViews) content.addView(v);
        root.addView(content, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f));

        // ---- drawer overlay ------------------------------------------------
        FrameLayout outer = new FrameLayout(this);
        outer.addView(root);

        drawerScrim = new FrameLayout(this);
        drawerScrim.setBackgroundColor(Color.parseColor("#88000000"));
        drawerScrim.setVisibility(View.GONE);
        drawerScrim.setOnClickListener(v -> closeDrawer());

        drawerPanel = new LinearLayout(this);
        drawerPanel.setOrientation(LinearLayout.VERTICAL);
        drawerPanel.setBackgroundColor(Color.WHITE);
        drawerPanel.setPadding(dp(10), dp(14), dp(10), dp(14));
        drawerPanel.setClickable(true); // taps inside don't close
        TextView dTitle = new TextView(this);
        dTitle.setText("TC RFID Sweep");
        dTitle.setTextSize(17);
        dTitle.setTypeface(null, Typeface.BOLD);
        dTitle.setTextColor(C_TEXT);
        dTitle.setPadding(dp(6), 0, 0, dp(10));
        drawerPanel.addView(dTitle);
        for (int i = 0; i < TAB_COUNT; i++) {
            final int tab = i;
            Button b = smallBtn(TAB_NAMES[i]);
            b.setTextSize(15);
            b.setMinimumHeight(dp(46));
            b.setOnClickListener(v -> {
                closeDrawer();
                selectTab(tab);
            });
            tabBtns[i] = b;
            LinearLayout.LayoutParams bl = new LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT);
            bl.bottomMargin = dp(6);
            drawerPanel.addView(b, bl);
        }
        gearBtn = smallBtn("⚙  Settings");
        gearBtn.setTextSize(14);
        gearBtn.setMinimumHeight(dp(44));
        gearBtn.setOnClickListener(v -> {
            closeDrawer();
            showSettings();
        });
        LinearLayout.LayoutParams gl = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT);
        gl.topMargin = dp(14);
        drawerPanel.addView(gearBtn, gl);

        drawerScrim.addView(drawerPanel, new FrameLayout.LayoutParams(
                dp(210), FrameLayout.LayoutParams.MATCH_PARENT,
                Gravity.START));
        outer.addView(drawerScrim);

        buildItemEditor(outer);

        setContentView(outer);

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
        batchAdapter = new BatchAdapter();
        batchListView.setAdapter(batchAdapter);
        batchListView.setDivider(null);
        batchListView.setDividerHeight(0);
        v.addView(batchListView, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f));

        batchBtnRow = new LinearLayout(this);
        Button back = smallBtn("← BACK");
        back.setOnClickListener(x -> stepBack());
        batchBtnRow.addView(back, weight());
        Button next = smallBtn("NEXT →");
        next.setOnClickListener(x -> stepNext());
        batchBtnRow.addView(next, weight());
        Button undo = smallBtn("UNDO");
        undo.setOnClickListener(x -> undoPair());
        undo.setOnLongClickListener(x -> {
            undoAllPairing();
            return true;
        });
        batchBtnRow.addView(undo, weight());
        Button sweepBtn = smallBtn("SWEEP");
        sweepBtn.setOnClickListener(x -> {
            if (step == STEP_PAIR) sweepForUnlinked();
            else undoAllPairing();
        });
        batchBtnRow.addView(sweepBtn, weight());
        Button exit = smallBtn("EXIT");
        exit.setOnClickListener(x -> exitBatch(false));
        batchBtnRow.addView(exit, weight());
        v.addView(batchBtnRow);

        batchListView.setOnItemClickListener((parent, view, pos, id) -> {
            if (inBatch() && step == STEP_CHECK && pos < checkEntries.size()) {
                openItemEditor(checkEntries.get(pos));
            }
        });

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

    // FIND BIN: scan anything, see where it's supposed to live.
    private TextView findResult;
    private ImageView findImg;

    private View buildFindView() {
        LinearLayout v = new LinearLayout(this);
        v.setOrientation(LinearLayout.VERTICAL);
        TextView t = new TextView(this);
        t.setText("Where does this live?");
        t.setTextSize(17);
        t.setTypeface(null, Typeface.BOLD);
        t.setTextColor(C_TEXT);
        v.addView(t);
        TextView hint = new TextView(this);
        hint.setText("Scan a barcode or SKU — the bin comes back.");
        hint.setTextSize(13);
        hint.setTextColor(C_MUTED);
        hint.setPadding(0, 0, 0, dp(8));
        v.addView(hint);
        findImg = new ImageView(this);
        findImg.setScaleType(ImageView.ScaleType.FIT_CENTER);
        findImg.setBackgroundColor(C_BG);
        v.addView(findImg, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, dp(120)));
        findResult = new TextView(this);
        findResult.setTextSize(15);
        findResult.setTextColor(C_TEXT);
        findResult.setPadding(0, dp(8), 0, 0);
        v.addView(findResult, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f));
        return v;
    }

    private void findLookup(String code) {
        status.setText("Looking up " + code + "…");
        new Thread(() -> {
            try {
                JSONObject p = api("GET", "/api/products/by-barcode/"
                        + URLEncoder.encode(code, "UTF-8"), null);
                final String bin = p.optString("bin_location", "");
                final String title = p.optString("product_title", "(unknown)");
                final String variant = p.isNull("variant_title") ? ""
                        : p.optString("variant_title");
                final String sku = p.isNull("sku") ? "—" : p.optString("sku");
                final String img = p.isNull("image_url") ? null
                        : p.optString("image_url");
                ui.post(() -> {
                    boolean has = !bin.isEmpty()
                            && !bin.equalsIgnoreCase("No bin assigned");
                    beep(has ? SOUND_OK : SOUND_OTHER);
                    findResult.setText(
                            (has ? "BIN  " + bin : "NO BIN ASSIGNED")
                            + "\n\n" + title
                            + (variant.isEmpty() ? "" : " (" + variant + ")")
                            + "\nSKU: " + sku);
                    findResult.setTextSize(has ? 20 : 16);
                    loadImage(img, findImg);
                    status.setText(has ? "Found ✓" : "This product has no "
                            + "bin set in Shopify.");
                    btInput.requestFocus();
                });
            } catch (Exception e) {
                ui.post(() -> {
                    beep(SOUND_ERR);
                    findResult.setText("Not found:\n" + e.getMessage());
                    loadImage(null, findImg);
                    btInput.requestFocus();
                });
            }
        }).start();
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

    // ------------------------------------------------ check-item editor -----
    private FrameLayout editScrim;
    private ImageView editImg;
    private TextView editName;
    private TextView editMeta;
    private TextView editFlags;
    private TextView editPos;
    private Button editUse;
    private Button editPrev;
    private Button editNext;
    private LinearLayout editNameRow;
    private EditText editNameIn;
    private TextView editQty;
    private TextView editMsg;
    private LinearLayout editBinRow;
    private TextView editBinText;
    private LinearLayout editLabelRow;
    private Button editLabelMode;
    private EditText editLabelText;
    private Button editDropBtn;

    private void buildItemEditor(FrameLayout outer) {
        editScrim = new FrameLayout(this);
        editScrim.setBackgroundColor(Color.parseColor("#99000000"));
        editScrim.setVisibility(View.GONE);
        editScrim.setOnClickListener(v -> closeItemEditor());

        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setBackgroundColor(Color.WHITE);
        panel.setPadding(dp(8), dp(10), dp(8), dp(10));
        panel.setClickable(true);

        LinearLayout nav = new LinearLayout(this);
        nav.setGravity(Gravity.CENTER_VERTICAL);
        editPrev = smallBtn("◀");
        editPrev.setOnClickListener(v -> {
            if (editIdx > 0) {
                editIdx--;
                renderItemEditor();
            }
        });
        nav.addView(editPrev, new LinearLayout.LayoutParams(dp(44),
                LinearLayout.LayoutParams.WRAP_CONTENT));

        LinearLayout mid = new LinearLayout(this);
        mid.setOrientation(LinearLayout.VERTICAL);
        editImg = new ImageView(this);
        editImg.setScaleType(ImageView.ScaleType.FIT_CENTER);
        editImg.setBackgroundColor(C_BG);
        LinearLayout.LayoutParams il = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, dp(110));
        mid.addView(editImg, il);
        editName = new TextView(this);
        editName.setTextSize(16);
        editName.setTypeface(null, Typeface.BOLD);
        editName.setTextColor(C_TEXT);
        editName.setPadding(0, dp(6), 0, 0);
        mid.addView(editName);
        editMeta = new TextView(this);
        editMeta.setTextSize(13);
        editMeta.setTextColor(C_MUTED);
        mid.addView(editMeta);
        editFlags = new TextView(this);
        editFlags.setTextSize(13);
        editFlags.setTextColor(Color.parseColor("#8a6116"));
        editFlags.setPadding(0, dp(4), 0, 0);
        mid.addView(editFlags);
        editPos = new TextView(this);
        editPos.setTextSize(13);
        editPos.setTextColor(C_BLUE);
        mid.addView(editPos);
        editUse = smallBtn("USE THIS LISTING");
        editUse.setOnClickListener(v -> reassignToShown());
        mid.addView(editUse);
        editNameRow = new LinearLayout(this);
        editNameIn = new EditText(this);
        editNameIn.setHint("Label name (confirm)");
        editNameIn.setTextSize(13);
        editNameRow.addView(editNameIn, weight());
        Button saveName = smallBtn("SAVE");
        saveName.setOnClickListener(v -> saveEditorName());
        editNameRow.addView(saveName, new LinearLayout.LayoutParams(dp(70),
                LinearLayout.LayoutParams.WRAP_CONTENT));
        mid.addView(editNameRow);

        // Wrong shelf: move it, drop it, or ignore for this batch.
        editBinRow = new LinearLayout(this);
        editBinRow.setOrientation(LinearLayout.VERTICAL);
        editBinText = new TextView(this);
        editBinText.setTextSize(13);
        editBinText.setTextColor(Color.parseColor("#8a6116"));
        editBinRow.addView(editBinText);
        LinearLayout binBtns = new LinearLayout(this);
        Button bDrop = smallBtn("Belongs elsewhere");
        bDrop.setOnClickListener(v -> dropItemFromBatch(false));
        binBtns.addView(bDrop, weight());
        Button bMove = smallBtn("Move to " + "this bin");
        bMove.setOnClickListener(v -> moveItemBinToBatch());
        binBtns.addView(bMove, weight());
        Button bIgnore = smallBtn("Ignore");
        bIgnore.setOnClickListener(v -> {
            if (editEntry != null) ignoredBins.add(editEntry.item.id);
            closeItemEditor();
            status.setText("Ignored for this batch.");
            fetchReview();
        });
        binBtns.addView(bIgnore, weight());
        editBinRow.addView(binBtns);
        mid.addView(editBinRow);

        // Label format: Change Name / Change SKU / Change Both.
        editLabelRow = new LinearLayout(this);
        editLabelRow.setOrientation(LinearLayout.VERTICAL);
        TextView lblHint = new TextView(this);
        lblHint.setText("Label format:");
        lblHint.setTextSize(12);
        lblHint.setTextColor(C_MUTED);
        editLabelRow.addView(lblHint);
        LinearLayout lblRow = new LinearLayout(this);
        editLabelMode = smallBtn("Change Name");
        editLabelMode.setOnClickListener(v -> cycleLabelMode());
        lblRow.addView(editLabelMode, new LinearLayout.LayoutParams(
                dp(104), LinearLayout.LayoutParams.WRAP_CONTENT));
        editLabelText = new EditText(this);
        editLabelText.setHint("blank = standard label");
        editLabelText.setTextSize(13);
        lblRow.addView(editLabelText, weight());
        Button lblSave = smallBtn("SAVE");
        lblSave.setOnClickListener(v -> saveLabelFormat());
        lblRow.addView(lblSave, new LinearLayout.LayoutParams(dp(64),
                LinearLayout.LayoutParams.WRAP_CONTENT));
        editLabelRow.addView(lblRow);
        mid.addView(editLabelRow);

        editDropBtn = smallBtn("REMOVE THIS SCAN");
        editDropBtn.setOnClickListener(v -> dropItemFromBatch(true));
        mid.addView(editDropBtn);

        LinearLayout qtyRow = new LinearLayout(this);
        qtyRow.setGravity(Gravity.CENTER_VERTICAL);
        Button minus = smallBtn("−");
        minus.setOnClickListener(v -> editorAdjust(-1));
        qtyRow.addView(minus, new LinearLayout.LayoutParams(dp(52),
                LinearLayout.LayoutParams.WRAP_CONTENT));
        editQty = new TextView(this);
        editQty.setTextSize(18);
        editQty.setTypeface(null, Typeface.BOLD);
        editQty.setTextColor(C_TEXT);
        editQty.setGravity(Gravity.CENTER);
        qtyRow.addView(editQty, new LinearLayout.LayoutParams(dp(80),
                LinearLayout.LayoutParams.WRAP_CONTENT));
        Button plus = smallBtn("+");
        plus.setOnClickListener(v -> editorAdjust(1));
        qtyRow.addView(plus, new LinearLayout.LayoutParams(dp(52),
                LinearLayout.LayoutParams.WRAP_CONTENT));
        mid.addView(qtyRow);
        editMsg = new TextView(this);
        editMsg.setTextSize(12);
        editMsg.setTextColor(C_MUTED);
        mid.addView(editMsg);
        Button close = smallBtn("CLOSE");
        close.setOnClickListener(v -> closeItemEditor());
        mid.addView(close);
        nav.addView(mid, weight());

        editNext = smallBtn("▶");
        editNext.setOnClickListener(v -> {
            if (editEntry != null && editIdx < editEntry.candidates.size() - 1) {
                editIdx++;
                renderItemEditor();
            }
        });
        nav.addView(editNext, new LinearLayout.LayoutParams(dp(44),
                LinearLayout.LayoutParams.WRAP_CONTENT));
        panel.addView(nav);

        FrameLayout.LayoutParams pl = new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.CENTER);
        pl.leftMargin = dp(6);
        pl.rightMargin = dp(6);
        editScrim.addView(panel, pl);
        outer.addView(editScrim);
    }

    private void openItemEditor(CheckEntry entry) {
        editEntry = entry;
        editIdx = 0;
        for (int i = 0; i < entry.candidates.size(); i++) {
            if (entry.candidates.get(i).optString("shopify_variant_id")
                    .equals(entryVariantId(entry))) {
                editIdx = i;
                break;
            }
        }
        editMsg.setText("");
        editScrim.setVisibility(View.VISIBLE);
        renderItemEditor();
    }

    private String entryVariantId(CheckEntry e) {
        return e.item.variantId == null ? "" : e.item.variantId;
    }

    private void closeItemEditor() {
        editScrim.setVisibility(View.GONE);
        editEntry = null;
    }

    private void renderItemEditor() {
        if (editEntry == null) return;
        BItem it = editEntry.item;
        boolean multi = editEntry.candidates.size() > 1;
        JSONObject cand = multi ? editEntry.candidates.get(editIdx) : null;
        String name = cand != null
                ? cand.optString("product_title", "(unknown)")
                  + (cand.isNull("variant_title")
                     || cand.optString("variant_title").isEmpty()
                     ? "" : " (" + cand.optString("variant_title") + ")")
                : it.name();
        String sku = cand != null
                ? (cand.isNull("sku") ? "—" : cand.optString("sku"))
                : (it.sku == null ? "—" : it.sku);
        String bc = cand != null
                ? (cand.isNull("barcode") ? "—" : cand.optString("barcode"))
                : (it.barcode == null ? it.scannedCode : it.barcode);
        String bin = cand != null
                ? cand.optString("bin_location", "—")
                : "—";
        String img = cand != null
                ? (cand.isNull("image_url") ? null
                   : cand.optString("image_url"))
                : it.imageUrl;
        editName.setText(name);
        editMeta.setText("SKU: " + sku + "\nBarcode: " + bc
                + "  ·  Bin: " + bin);
        loadImage(img, editImg);
        editFlags.setText("⚠ " + flagText(editEntry.flags));
        editPrev.setVisibility(multi ? View.VISIBLE : View.INVISIBLE);
        editNext.setVisibility(multi ? View.VISIBLE : View.INVISIBLE);
        editPrev.setEnabled(editIdx > 0);
        editNext.setEnabled(editIdx < editEntry.candidates.size() - 1);
        if (multi) {
            boolean current = cand.optString("shopify_variant_id")
                    .equals(entryVariantId(editEntry));
            editPos.setVisibility(View.VISIBLE);
            editPos.setText("Listing " + (editIdx + 1) + " of "
                    + editEntry.candidates.size() + " sharing this barcode"
                    + (current ? "  — currently selected" : ""));
            editUse.setVisibility(View.VISIBLE);
            editUse.setEnabled(!current);
        } else {
            editPos.setVisibility(View.GONE);
            editUse.setVisibility(View.GONE);
        }
        editNameRow.setVisibility(
                editEntry.flags.contains("unconfirmed-name")
                        ? View.VISIBLE : View.GONE);
        boolean wrongBin = editEntry.flags.contains("wrong-bin");
        editBinRow.setVisibility(wrongBin ? View.VISIBLE : View.GONE);
        if (wrongBin) {
            editBinText.setText("On this shelf (" + batchBin + ") but the "
                    + "system has it in " + it.binLocation + ".");
        }
        editLabelRow.setVisibility(it.resolved ? View.VISIBLE : View.GONE);
        editDropBtn.setVisibility(it.resolved ? View.GONE : View.VISIBLE);
        editQty.setText(String.valueOf(it.qty)
                + (it.expected != null ? " / " + it.expected : ""));
    }

    private static final String[] LABEL_MODES = {"header", "sku", "both"};
    private String labelMode = "header";

    private void cycleLabelMode() {
        int i = 0;
        for (int j = 0; j < LABEL_MODES.length; j++) {
            if (LABEL_MODES[j].equals(labelMode)) i = j;
        }
        labelMode = LABEL_MODES[(i + 1) % LABEL_MODES.length];
        editLabelMode.setText("header".equals(labelMode) ? "Change Name"
                : "sku".equals(labelMode) ? "Change SKU" : "Change Both");
    }

    private void saveLabelFormat() {
        if (editEntry == null || editEntry.item.sku == null) return;
        final String sku = editEntry.item.sku;
        final String name = editLabelText.getText().toString().trim();
        final String mode = labelMode;
        new Thread(() -> {
            try {
                JSONObject body = new JSONObject()
                        .put("label_name", name)
                        .put("placement", mode)
                        .put("updated_by", prefs.getString("device", "C72"));
                api("PUT", "/api/label-names/"
                        + URLEncoder.encode(sku, "UTF-8"), body);
                ui.post(() -> editMsg.setText(name.isEmpty()
                        ? "Cleared ✓ — standard label."
                        : "Saved ✓ — prints as the "
                          + ("both".equals(mode) ? "name and SKU"
                             : "sku".equals(mode) ? "SKU line" : "name")));
            } catch (Exception e) {
                ui.post(() -> editMsg.setText(e.getMessage()));
            }
        }).start();
    }

    private void dropItemFromBatch(boolean unresolved) {
        if (editEntry == null) return;
        final int itemId = editEntry.item.id;
        final String what = unresolved
                ? "Remove this unresolved scan from the list?\n\nNothing "
                  + "permanent changes — scanning it again brings it back."
                : "Drop this product from the batch?\n\nIts boxes stop "
                  + "counting here and no labels print for it.";
        new AlertDialog.Builder(this)
                .setMessage(what)
                .setPositiveButton("Remove", (d, w) -> new Thread(() -> {
                    try {
                        api("DELETE", "/api/batches/" + batchId + "/items/"
                                + itemId, null);
                        ui.post(() -> {
                            beep(SOUND_OK);
                            closeItemEditor();
                            status.setText("Removed from the batch.");
                            reloadBatchAndReview();
                        });
                    } catch (Exception e) {
                        ui.post(() -> editMsg.setText(e.getMessage()));
                    }
                }).start())
                .setNegativeButton("Cancel", null)
                .show();
    }

    private void moveItemBinToBatch() {
        if (editEntry == null) return;
        final BItem it = editEntry.item;
        new AlertDialog.Builder(this)
                .setMessage("Update this product's bin in Shopify from "
                        + it.binLocation + " to " + batchBin + "?")
                .setPositiveButton("Move it", (d, w) -> new Thread(() -> {
                    try {
                        JSONObject body = new JSONObject()
                                .put("target", it.sku != null ? it.sku
                                        : it.barcode)
                                .put("new_bin", batchBin)
                                .put("changed_by",
                                        prefs.getString("device", "C72"));
                        api("POST", "/api/bin-updates", body);
                        ui.post(() -> {
                            beep(SOUND_OK);
                            closeItemEditor();
                            status.setText("Bin updated to " + batchBin
                                    + " in Shopify.");
                            reloadBatchAndReview();
                        });
                    } catch (Exception e) {
                        ui.post(() -> editMsg.setText(e.getMessage()));
                    }
                }).start())
                .setNegativeButton("Cancel", null)
                .show();
    }

    private String flagText(List<String> flags) {
        StringBuilder sb = new StringBuilder();
        for (String f : flags) {
            if (sb.length() > 0) sb.append(" · ");
            if ("ambiguous".equals(f)) sb.append("several listings share "
                    + "this barcode");
            else if ("count-mismatch".equals(f)) sb.append("count differs "
                    + "from Shopify");
            else if ("unconfirmed-name".equals(f)) sb.append("serial name "
                    + "not confirmed");
            else if ("unresolved".equals(f)) sb.append("unknown barcode");
            else if ("wrong-bin".equals(f)) sb.append("saved bin is a "
                    + "different shelf");
            else sb.append(f);
        }
        return sb.toString();
    }

    private void reassignToShown() {
        if (editEntry == null || editEntry.candidates.isEmpty()) return;
        final JSONObject cand = editEntry.candidates.get(editIdx);
        final int itemId = editEntry.item.id;
        editMsg.setText("Reassigning…");
        new Thread(() -> {
            try {
                JSONObject body = new JSONObject().put("shopify_variant_id",
                        cand.optString("shopify_variant_id"));
                api("POST", "/api/batches/" + batchId + "/items/" + itemId
                        + "/reassign", body);
                ui.post(() -> {
                    beep(SOUND_OK);
                    closeItemEditor();
                    status.setText("Reassigned ✓ — refreshing…");
                    reloadBatchAndReview();
                });
            } catch (Exception e) {
                ui.post(() -> editMsg.setText(e.getMessage()));
            }
        }).start();
    }

    private void saveEditorName() {
        if (editEntry == null || editEntry.item.serialPrefix == null) return;
        final String name = editNameIn.getText().toString().trim();
        if (name.isEmpty()) return;
        final String prefix = editEntry.item.serialPrefix;
        new Thread(() -> {
            try {
                JSONObject body = new JSONObject().put("label_name", name);
                api("PUT", "/api/serial-prefixes/"
                        + URLEncoder.encode(prefix, "UTF-8") + "/label",
                        body);
                ui.post(() -> editMsg.setText("Name confirmed ✓"));
            } catch (Exception e) {
                ui.post(() -> editMsg.setText(e.getMessage()));
            }
        }).start();
    }

    private void editorAdjust(int delta) {
        if (editEntry == null) return;
        final BItem it = editEntry.item;
        final int qty = Math.max(0, it.qty + delta);
        new Thread(() -> {
            try {
                JSONObject body = new JSONObject().put("qty", qty);
                JSONObject resp = api("POST", "/api/batches/" + batchId
                        + "/items/" + it.id + "/qty", body);
                final BItem updated = BItem.from(resp);
                ui.post(() -> {
                    editEntry.item = updated;
                    BItem inList = itemById(updated.id);
                    if (inList != null) {
                        bItems.set(bItems.indexOf(inList), updated);
                    }
                    renderItemEditor();
                });
            } catch (Exception e) {
                ui.post(() -> editMsg.setText(e.getMessage()));
            }
        }).start();
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

    // ------------------------------------------------------------ drawer ----
    private void toggleDrawer() {
        if (drawerScrim.getVisibility() == View.VISIBLE) {
            closeDrawer();
            return;
        }
        for (int i = 0; i < TAB_COUNT; i++) {
            tabBtns[i].setVisibility(tabVisible(i) ? View.VISIBLE : View.GONE);
            tabBtns[i].setBackgroundColor(i == activeTab ? C_BLUE : C_CHIP);
            tabBtns[i].setTextColor(i == activeTab ? Color.WHITE : C_TEXT);
        }
        drawerScrim.setVisibility(View.VISIBLE);
        android.view.animation.TranslateAnimation slide =
                new android.view.animation.TranslateAnimation(
                        -dp(210), 0, 0, 0);
        slide.setDuration(150);
        drawerPanel.startAnimation(slide);
    }

    private void closeDrawer() {
        drawerScrim.setVisibility(View.GONE);
    }

    private void selectTab(int tab) {
        activeTab = tab;
        for (int i = 0; i < TAB_COUNT; i++) {
            tabViews[i].setVisibility(i == tab ? View.VISIBLE : View.GONE);
        }
        boolean needsInput = tab == TAB_BATCH || tab == TAB_STATION
                || tab == TAB_FIND;
        btInput.setVisibility(needsInput ? View.VISIBLE : View.GONE);
        tabTitle.setVisibility(needsInput ? View.GONE : View.VISIBLE);
        tabTitle.setText(TAB_NAMES[tab]);
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
                : tab == TAB_SWEEP ? "tab_sweep"
                : tab == TAB_FIND ? "tab_find" : "tab_locate";
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
            if (step == STEP_PAIR) pairSelect(code);
            else if (step == STEP_CHECK) {
                beep(SOUND_ERR);
                status.setText("CHECK step — tap flagged items to review, "
                        + "or BACK to keep scanning.");
            } else batchScan(code);
        } else if (activeTab == TAB_STATION) {
            stationLookup(code);
        } else if (activeTab == TAB_FIND) {
            findLookup(code);
        } else {
            status.setText("Scanned " + code + " — switch to BATCH, "
                    + "STATION or FIND BIN to use barcodes.");
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
            if (inBatch() && step == STEP_PAIR) {
                pairReadTag();
            } else if (inBatch()) {
                beep(SOUND_ERR);
                status.setText("RFID stickers pair in the PAIR step — "
                        + "press NEXT until you get there.");
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
        // The chip is a step indicator now; tapping it only opens the
        // picker when no batch is loaded. Steps move via BACK / NEXT.
        if (!inBatch()) openBatchPicker();
    }

    // --------------------------------------------------------- step flow ----
    private void stepBack() {
        if (!inBatch() || step == STEP_COLLECT) return;
        step--;
        pairActive = null;
        if (step == STEP_CHECK) fetchReview();
        applyBatchUi();
    }

    private void stepNext() {
        if (!inBatch()) return;
        if (step == STEP_COLLECT) {
            boolean any = false;
            for (BItem b : bItems) if (b.qty > 0) any = true;
            if (!any) {
                beep(SOUND_ERR);
                status.setText("Scan at least one box first.");
                return;
            }
            step = STEP_CHECK;
            fetchReview();
            applyBatchUi();
        } else if (step == STEP_CHECK) {
            // Print, or jump straight to pairing when the labels already
            // exist (re-pairing a shelf shouldn't reprint 34 stickers).
            new AlertDialog.Builder(this)
                    .setTitle("Labels")
                    .setMessage("Print labels for this bin, or skip "
                            + "printing and go straight to pairing?")
                    .setPositiveButton("Print labels",
                            (d, w) -> queueLabels())
                    .setNeutralButton("Skip → pair", (d, w) -> skipPrint())
                    .setNegativeButton("Cancel", null)
                    .show();
        } else {
            finishBatch();
        }
    }

    private void skipPrint() {
        new Thread(() -> {
            try {
                api("POST", "/api/batches/" + batchId + "/skip-print",
                        new JSONObject());
                ui.post(() -> {
                    beep(SOUND_OK);
                    step = STEP_PAIR;
                    applyBatchUi();
                    status.setText("Straight to pairing — no labels queued.");
                });
            } catch (Exception e) {
                ui.post(() -> status.setText(e.getMessage()));
            }
        }).start();
    }

    // Release every tie this batch made so a shelf can be re-paired without
    // reprinting anything.
    private void undoAllPairing() {
        int paired = 0;
        for (BItem b : bItems) paired += b.paired;
        if (paired == 0) {
            status.setText("Nothing paired in this batch yet.");
            return;
        }
        final int n = paired;
        new AlertDialog.Builder(this)
                .setTitle("Undo ALL pairing?")
                .setMessage("Release all " + n + " tag(s) tied in this "
                        + "batch?\n\nThe printed labels stay valid — you "
                        + "just re-scan them onto their products. Nothing "
                        + "in Shopify changes.")
                .setPositiveButton("Release " + n, (d, w) -> new Thread(() -> {
                    try {
                        JSONObject resp = api("POST", "/api/batches/"
                                + batchId + "/unpair-all", new JSONObject());
                        final int removed = resp.optInt("removed");
                        ui.post(() -> {
                            beep(SOUND_OK);
                            pairActive = null;
                            pairHistory.clear();
                            status.setText(removed + " tie(s) released — "
                                    + "pair the shelf again.");
                            reloadBatchOnly();
                        });
                    } catch (Exception e) {
                        ui.post(() -> status.setText(e.getMessage()));
                    }
                }).start())
                .setNegativeButton("Cancel", null)
                .show();
    }

    private void reloadBatchOnly() {
        new Thread(() -> {
            try {
                JSONObject resp = api("GET", "/api/batches/" + batchId, null);
                JSONArray items = resp.getJSONArray("items");
                final List<BItem> loaded = new ArrayList<>();
                for (int i = 0; i < items.length(); i++) {
                    loaded.add(BItem.from(items.getJSONObject(i)));
                }
                ui.post(() -> {
                    bItems.clear();
                    bItems.addAll(loaded);
                    previewItem = null;
                    refreshBatchList();
                    updateBatchCard();
                });
            } catch (Exception e) {
                ui.post(() -> status.setText(e.getMessage()));
            }
        }).start();
    }

    // The unreadable-label rescue: sweep the shelf, find tags nothing owns,
    // and tie them to the product you're pairing.
    private void sweepForUnlinked() {
        if (pairActive == null) {
            beep(SOUND_ERR);
            status.setText("Scan the product's barcode first, then sweep.");
            return;
        }
        if (!readerReady) {
            status.setText("RFID reader not ready.");
            return;
        }
        final BItem target = pairActive;
        status.setText("Sweeping for unlinked tags… hold near the boxes");
        synchronized (tags) { tags.clear(); }
        if (!reader.startInventoryTag()) {
            status.setText("Could not start the sweep.");
            return;
        }
        scanning = true;
        ui.postDelayed(() -> {
            try {
                reader.stopInventory();
            } catch (Exception ignored) {
            }
            scanning = false;
            final List<String> swept = new ArrayList<>();
            synchronized (tags) { swept.addAll(tags.keySet()); }
            if (swept.isEmpty()) {
                beep(SOUND_ERR);
                status.setText("Swept nothing — get closer and try again.");
                return;
            }
            status.setText("Checking " + swept.size() + " tag(s)…");
            new Thread(() -> {
                try {
                    JSONObject body = new JSONObject()
                            .put("epcs", new JSONArray(swept));
                    JSONObject resp = api("POST", "/api/batches/" + batchId
                            + "/unlinked", body);
                    JSONArray un = resp.getJSONArray("unlinked");
                    final List<String> orphans = new ArrayList<>();
                    for (int i = 0; i < un.length(); i++) {
                        orphans.add(un.getString(i));
                    }
                    ui.post(() -> showUnlinkedDialog(orphans, target));
                } catch (Exception e) {
                    ui.post(() -> status.setText(e.getMessage()));
                }
            }).start();
        }, 4000);
    }

    private void showUnlinkedDialog(List<String> orphans, BItem target) {
        if (orphans.isEmpty()) {
            beep(SOUND_OTHER);
            status.setText("Every tag swept is already linked — nothing "
                    + "orphaned here.");
            return;
        }
        final boolean[] picked = new boolean[orphans.size()];
        String[] labels = new String[orphans.size()];
        for (int i = 0; i < orphans.size(); i++) {
            String e = orphans.get(i);
            labels[i] = "…" + e.substring(Math.max(0, e.length() - 8));
            picked[i] = orphans.size() == 1; // lone orphan: pre-ticked
        }
        beep(SOUND_OK);
        new AlertDialog.Builder(this)
                .setTitle(orphans.size() + " unlinked tag(s) nearby")
                .setMultiChoiceItems(labels, picked,
                        (d, which, isChecked) -> picked[which] = isChecked)
                .setPositiveButton("Assign ticked to " + target.name(),
                        (d, w) -> {
                            List<String> chosen = new ArrayList<>();
                            for (int i = 0; i < picked.length; i++) {
                                if (picked[i]) chosen.add(orphans.get(i));
                            }
                            assignEpcs(chosen, target);
                        })
                .setNegativeButton("Cancel", null)
                .show();
    }

    private void assignEpcs(List<String> epcs, BItem target) {
        if (epcs.isEmpty()) return;
        new Thread(() -> {
            int ok = 0;
            String err = null;
            for (String epc : epcs) {
                try {
                    JSONObject body = new JSONObject()
                            .put("epc", epc)
                            .put("item_id", target.id)
                            .put("created_by",
                                    prefs.getString("device", "C72"));
                    api("POST", "/api/batches/" + batchId + "/pair", body);
                    pairHistory.push(new String[]{epc,
                            String.valueOf(target.id)});
                    ok++;
                } catch (Exception e) {
                    err = e.getMessage();
                }
            }
            final int done = ok;
            final String problem = err;
            ui.post(() -> {
                beep(done > 0 ? SOUND_OK : SOUND_ERR);
                status.setText(done + " tag(s) assigned to "
                        + target.name()
                        + (problem != null ? " · " + problem : ""));
                reloadBatchOnly();
            });
        }).start();
    }

    private void fetchReview() {
        status.setText("Checking the batch…");
        checkEntries.clear();
        checkFlagText.clear();
        refreshBatchList();
        new Thread(() -> {
            try {
                JSONObject resp = api("GET",
                        "/api/batches/" + batchId + "/review", null);
                JSONArray arr = resp.getJSONArray("items");
                final List<CheckEntry> loaded = new ArrayList<>();
                for (int i = 0; i < arr.length(); i++) {
                    JSONObject o = arr.getJSONObject(i);
                    CheckEntry e = new CheckEntry();
                    e.item = BItem.from(o.getJSONObject("item"));
                    JSONArray fl = o.getJSONArray("flags");
                    for (int j = 0; j < fl.length(); j++) {
                        String flag = fl.getString(j);
                        // "Ignore for this batch" hides only that warning.
                        if ("wrong-bin".equals(flag)
                                && ignoredBins.contains(e.item.id)) {
                            continue;
                        }
                        e.flags.add(flag);
                    }
                    if (e.flags.isEmpty()) continue;
                    JSONArray cs = o.getJSONArray("candidates");
                    for (int j = 0; j < cs.length(); j++) {
                        e.candidates.add(cs.getJSONObject(j));
                    }
                    loaded.add(e);
                }
                ui.post(() -> {
                    checkEntries.clear();
                    checkEntries.addAll(loaded);
                    checkFlagText.clear();
                    for (CheckEntry e : checkEntries) {
                        checkFlagText.put(e.item.id,
                                "⚠ " + flagText(e.flags));
                    }
                    if (step == STEP_CHECK) {
                        status.setText(checkEntries.isEmpty()
                                ? "Nothing needs checking ✓ — NEXT queues "
                                  + "the labels."
                                : checkEntries.size() + " item(s) need a "
                                  + "look — tap one to review. NEXT queues "
                                  + "the labels.");
                        refreshBatchList();
                    }
                });
            } catch (Exception e) {
                ui.post(() -> status.setText("Check failed: "
                        + e.getMessage()));
            }
        }).start();
    }

    private void reloadBatchAndReview() {
        new Thread(() -> {
            try {
                JSONObject resp = api("GET", "/api/batches/" + batchId, null);
                JSONArray items = resp.getJSONArray("items");
                final List<BItem> loaded = new ArrayList<>();
                for (int i = 0; i < items.length(); i++) {
                    loaded.add(BItem.from(items.getJSONObject(i)));
                }
                ui.post(() -> {
                    bItems.clear();
                    bItems.addAll(loaded);
                    fetchReview();
                });
            } catch (Exception e) {
                ui.post(() -> status.setText(e.getMessage()));
            }
        }).start();
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
                    step = ("printing".equals(st) || "pairing".equals(st))
                            ? STEP_PAIR : STEP_COLLECT;
                    pairActive = null;
                    previewItem = null;
                    pairHistory.clear();
                    checkEntries.clear();
                    checkFlagText.clear();
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
        phaseChip.setText(in
                ? STEP_NAMES[step] + "  " + (step + 1) + "/3" : "PICK");
        pickBtn.setVisibility(in ? View.GONE : View.VISIBLE);
        batchBtnRow.setVisibility(in ? View.VISIBLE : View.GONE);
        if (in) {
            if (step == STEP_COLLECT) {
                status.setText("COLLECT: scan every box in this bin, then "
                        + "NEXT.");
            } else if (step == STEP_CHECK) {
                status.setText(checkEntries.isEmpty()
                        ? "CHECK: nothing flagged ✓ — NEXT queues labels."
                        : "CHECK: tap flagged items to review — NEXT "
                          + "queues labels.");
            } else {
                status.setText("PAIR: scan a product barcode, TRIGGER each "
                        + "sticker; NEXT finishes the bin.");
            }
        } else {
            status.setText("Pick an open batch (started on the PC/iPad).");
            batchCard.setVisibility(View.GONE);
        }
        updateBatchCard();
        refreshBatchList();
        if (activeTab == TAB_BATCH) btInput.requestFocus();
    }

    private void updateBatchCard() {
        BItem it = step == STEP_PAIR && pairActive != null
                ? pairActive : previewItem;
        if (step == STEP_CHECK) it = null; // check step: the list IS the view
        if (it == null) {
            batchCard.setVisibility(View.GONE);
            return;
        }
        batchCard.setVisibility(View.VISIBLE);
        batchName.setText(it.name());
        batchSku.setText(it.sku != null ? "SKU: " + it.sku : "no SKU");
        batchTracker.setText(trackerText(it));
        loadImage(it.imageUrl, batchImg);
    }

    private BItem itemById(int id) {
        for (BItem b : bItems) if (b.id == id) return b;
        return null;
    }

    private void refreshBatchList() {
        displayItems.clear();
        if (inBatch() && step == STEP_CHECK) {
            // Only flagged items — a clean bin shows an empty list.
            for (CheckEntry e : checkEntries) displayItems.add(e.item);
        } else {
            for (BItem b : bItems)
                if (b.qty > 0 || b.paired > 0) displayItems.add(b);
            for (BItem b : bItems)
                if (b.qty == 0 && b.paired == 0) displayItems.add(b);
        }
        batchAdapter.notifyDataSetChanged();
    }

    // Tracker = two numbers only: scanned/expected while collecting,
    // paired/scanned while pairing.
    private String trackerText(BItem b) {
        if (step == STEP_PAIR)
            return b.paired + "/" + Math.max(b.qty, b.paired);
        return b.expected != null ? b.qty + "/" + b.expected
                : String.valueOf(b.qty);
    }

    // Inventory cells modeled on the EasyScan-style card: image, bold name
    // with the room, labeled SKU/Barcode lines, tracker top-right.
    private class BatchAdapter extends BaseAdapter {
        @Override
        public int getCount() {
            return displayItems.size();
        }

        @Override
        public BItem getItem(int i) {
            return displayItems.get(i);
        }

        @Override
        public long getItemId(int i) {
            return displayItems.get(i).id;
        }

        @Override
        public View getView(int pos, View convert, ViewGroup parent) {
            CellHolder h;
            if (convert == null) {
                h = new CellHolder();
                LinearLayout wrap = new LinearLayout(MainActivity.this);
                wrap.setOrientation(LinearLayout.VERTICAL);
                wrap.setPadding(0, 0, 0, dp(6));

                FrameLayout card = new FrameLayout(MainActivity.this);
                card.setPadding(dp(8), dp(8), dp(8), dp(8));
                h.card = card;

                LinearLayout row = new LinearLayout(MainActivity.this);
                ImageView iv = new ImageView(MainActivity.this);
                iv.setScaleType(ImageView.ScaleType.CENTER_CROP);
                iv.setBackgroundColor(C_BG);
                LinearLayout.LayoutParams il =
                        new LinearLayout.LayoutParams(dp(56), dp(56));
                il.rightMargin = dp(8);
                row.addView(iv, il);
                h.img = iv;

                LinearLayout col = new LinearLayout(MainActivity.this);
                col.setOrientation(LinearLayout.VERTICAL);
                TextView nm = new TextView(MainActivity.this);
                nm.setTextSize(15);
                nm.setTypeface(null, Typeface.BOLD);
                nm.setTextColor(C_TEXT);
                nm.setPadding(0, 0, dp(50), 0); // clear of the tracker
                col.addView(nm);
                h.name = nm;
                TextView skuLine = new TextView(MainActivity.this);
                skuLine.setTextSize(13);
                skuLine.setTextColor(C_MUTED);
                col.addView(skuLine);
                h.sku = skuLine;
                TextView bcLine = new TextView(MainActivity.this);
                bcLine.setTextSize(13);
                bcLine.setTextColor(C_MUTED);
                col.addView(bcLine);
                h.bc = bcLine;
                row.addView(col, weight());
                card.addView(row);

                TextView tr = new TextView(MainActivity.this);
                tr.setTextSize(17);
                tr.setTypeface(null, Typeface.BOLD);
                tr.setTextColor(C_BLUE);
                FrameLayout.LayoutParams tl = new FrameLayout.LayoutParams(
                        FrameLayout.LayoutParams.WRAP_CONTENT,
                        FrameLayout.LayoutParams.WRAP_CONTENT,
                        Gravity.TOP | Gravity.END);
                tl.topMargin = dp(4);
                tl.rightMargin = dp(6);
                card.addView(tr, tl);
                h.tracker = tr;

                wrap.addView(card);
                convert = wrap;
                convert.setTag(h);
            } else {
                h = (CellHolder) convert.getTag();
            }

            BItem b = getItem(pos);
            h.card.setBackgroundColor(b == pairActive
                    ? Color.parseColor("#dbe9ff") : Color.WHITE);
            h.name.setText(b.name());
            h.sku.setText(b.sku != null ? "SKU: " + b.sku
                    : (b.resolved ? "no SKU" : "⚠ unknown barcode"));
            String flags = checkFlagText.get(b.id);
            String bc = b.barcode != null ? b.barcode : b.scannedCode;
            if (inBatch() && step == STEP_CHECK && flags != null) {
                h.bc.setVisibility(View.VISIBLE);
                h.bc.setText(flags);
            } else if (bc != null && !bc.isEmpty()) {
                h.bc.setVisibility(View.VISIBLE);
                h.bc.setText("Barcode: " + bc);
            } else {
                h.bc.setVisibility(View.GONE);
            }
            h.tracker.setText(trackerText(b));
            loadImage(b.imageUrl, h.img);
            return convert;
        }
    }

    private static class CellHolder {
        FrameLayout card;
        ImageView img;
        TextView name;
        TextView sku;
        TextView bc;
        TextView tracker;
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

    // Queue the batch's label run straight from the shelf — one label per
    // scanned box, printed by the warehouse laptop's agent. The server
    // only allows this once per batch (status guard), so a double-tap
    // can't print the bin twice; singles are reprinted from Print Queue.
    private void queueLabels() {
        if (!inBatch()) return;
        int total = 0;
        for (BItem b : bItems) if (b.resolved) total += b.qty;
        if (total == 0) {
            beep(SOUND_ERR);
            status.setText("Nothing to print — scan boxes first.");
            return;
        }
        final int n = total;
        new AlertDialog.Builder(this)
                .setTitle("Print labels for bin " + batchBin + "?")
                .setMessage(n + " label(s) — one per scanned box — will "
                        + "print at the warehouse printer. Collect them "
                        + "there, stick them on, then PAIR.")
                .setPositiveButton("Queue " + n + " label(s)",
                        (d, w) -> new Thread(() -> {
                    try {
                        JSONObject body = new JSONObject().put(
                                "requested_by",
                                prefs.getString("device", "C72"));
                        JSONObject resp = api("POST", "/api/batches/"
                                + batchId + "/queue-labels", body);
                        final int queued = resp.optInt("count");
                        ui.post(() -> {
                            beep(SOUND_OK);
                            step = STEP_PAIR;
                            applyBatchUi();
                            status.setText(queued + " label(s) queued ✓ — "
                                    + "printing at the warehouse laptop. "
                                    + "Stick them on, then pair.");
                        });
                    } catch (Exception e) {
                        final boolean already = String.valueOf(
                                e.getMessage()).contains("already");
                        ui.post(() -> {
                            if (already) {
                                // Labels were queued on an earlier pass —
                                // just move on to pairing.
                                step = STEP_PAIR;
                                applyBatchUi();
                                status.setText("Labels were already "
                                        + "queued — on to PAIR.");
                            } else {
                                beep(SOUND_ERR);
                                status.setText(e.getMessage());
                            }
                        });
                    }
                }).start())
                .setNegativeButton("Cancel", null)
                .show();
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
        step = STEP_COLLECT;
        checkEntries.clear();
        checkFlagText.clear();
        applyBatchUi();
        if (!completed) {
            status.setText("Left the batch (still open — resume any time).");
        }
    }

    private void finishBatch() {
        if (!inBatch()) return;
        // RFID check: every scanned box should have a tag paired before the
        // bin is finished. Short is allowed — but only past an explicit
        // warning that leads with what's missing.
        StringBuilder warn = new StringBuilder();
        int unpaired = 0, missingBoxes = 0, warnLines = 0;
        for (BItem b : bItems) {
            if (!b.resolved || b.paired >= b.qty) continue;
            unpaired++;
            missingBoxes += b.qty - b.paired;
            if (warnLines < 6) {
                warn.append("• ").append(b.name()).append(": ")
                        .append(b.paired).append("/").append(b.qty)
                        .append(" entered by RFID\n");
                warnLines++;
            }
        }
        StringBuilder sb = new StringBuilder();
        if (unpaired > 0) {
            sb.append("⚠ ").append(unpaired).append(" product(s) — ")
                    .append(missingBoxes).append(" box(es) — NOT entered "
                    + "into inventory with RFID tags yet:\n\n")
                    .append(warn);
            if (unpaired > 6) sb.append("…\n");
            sb.append("\nAre you sure? They'll be filed in Review as "
                    + "incomplete pairing.\n\n——————\n");
        }
        int diffs = 0, unresolved = 0, lines = 0;
        for (BItem b : bItems) {
            if (!b.resolved) {
                if (b.qty > 0) unresolved++;
                continue;
            }
            if (b.qty == 0 && b.paired == 0) continue;
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
                sb.append(b.name()).append(":  ").append(delta)
                        .append("  · ").append(b.paired).append("/")
                        .append(b.qty).append(" tagged").append("\n");
                lines++;
            }
        }
        if (lines == 0) sb.append("(no boxes scanned)\n");
        sb.append("\n");
        if (diffs > 0) sb.append(diffs).append(" count difference(s) will "
                + "be filed for Review.\n");
        if (unresolved > 0) sb.append(unresolved).append(" unknown "
                + "barcode(s) will be filed for Review.\n");
        if (diffs + unresolved + unpaired == 0) {
            sb.append("Everything matches and every box is tagged. "
                    + "Clean bin ✓\n");
        }
        sb.append("\nNo Shopify stock numbers change — differences go to "
                + "the Review tab for a decision.");
        new AlertDialog.Builder(this)
                .setTitle(unpaired > 0
                        ? "Finish bin " + batchBin + " with untagged boxes?"
                        : "Finish bin " + batchBin + "?")
                .setMessage(sb.toString())
                .setPositiveButton(unpaired > 0 ? "Finish anyway" : "Finish",
                        (d, w) -> new Thread(() -> {
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
                            : "SKU: " + p.optString("sku"))
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
        final CheckBox cbFind = new CheckBox(this);
        cbFind.setText("Find bin");
        cbFind.setChecked(prefs.getBoolean("tab_find", true));
        box.addView(cbFind);
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
                            .putBoolean("tab_find", cbFind.isChecked())
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
