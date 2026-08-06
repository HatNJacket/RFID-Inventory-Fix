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
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.StateListDrawable;
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
import android.widget.ScrollView;
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
    // First-run favourites only. Once the operator stars/renames their own,
    // these never reappear — favourites are theirs, not ours.
    private static final int[] PRESET_LEVELS = {2, 5, 10, 30};
    private static final String[] PRESET_NAMES = {
            "station", "bin", "rack", "locate"};

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
    // Style tokens matching the web terminal (Shopify-admin look): hairline
    // borders on white cards over the gray workspace, blue accents, rounded
    // pills instead of stock square gray buttons.
    private static final int C_LINE = Color.parseColor("#e1e3e5");
    private static final int C_PRESS = Color.parseColor("#e7e9eb");
    private static final int C_BLUE_DK = Color.parseColor("#00449e");
    private static final int C_SOFT = Color.parseColor("#e3edfb");
    private static final int C_SOFT_DK = Color.parseColor("#cbdef6");
    // Pair-step outcome colours, matching the web's glow states. The fills
    // are deliberately faint (alpha 0x22) so the product photo and text stay
    // readable; the tracker number carries the saturated colour.
    private static final int C_OK = Color.parseColor("#29845a");
    private static final int C_OVER = Color.parseColor("#d72c0d");
    private static final int C_OK_BG = Color.parseColor("#2229845a");
    private static final int C_OVER_BG = Color.parseColor("#22d72c0d");

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
    private FrameLayout loadingOverlay;
    private TextView loadingText;
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
    private Button btnNext;
    private Button btnUndo;
    private Button btnSweep;
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
    private Button pwrChipSweep;
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
        // A sealed case is one box, one label, one tag - but N units, so
        // units and labels stop being the same number.
        int caseCount;
        int caseUnits;
        int unitsTotal;
        int labelsTotal;
        // "Couldn't do this one": no barcode, wrapped, damaged label. Local
        // to the batch; never touches a quantity anywhere.
        boolean skipped;
        String skipReason;
        // Product-wide "won't RFID scan": the tag reads in hand but never
        // once it's on the box, so sweeps don't expect an answer.
        boolean noScan;
        // Boxes on this shelf already wearing a sticker (baseline sweep or
        // the first-scan question) — units on the shelf, but never labels.
        int taggedBefore;
        // Tags for this product already in the system from BEFORE this
        // batch (side trip, earlier session): triggers the first-scan ask.
        int priorTags;

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
            b.caseCount = o.optInt("case_count", 0);
            b.caseUnits = o.optInt("case_units", 0);
            // Fall back to the box count for servers that predate cases.
            b.unitsTotal = o.optInt("units_total", b.qty);
            b.labelsTotal = o.optInt("labels_total", b.qty);
            b.skipped = o.optBoolean("skipped", false);
            b.skipReason = o.isNull("skip_reason") ? null
                    : o.optString("skip_reason");
            b.noScan = o.optBoolean("rfid_incompatible", false);
            b.taggedBefore = o.optInt("tagged_before", 0);
            b.priorTags = o.optInt("prior_tags", 0);
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
    private static final int STEP_VERIFY = 3;
    private static final String[] STEP_NAMES =
            {"COLLECT", "CHECK", "PAIR", "VERIFY"};
    private static final int STEP_LAST = STEP_VERIFY;

    private static class CheckEntry {
        BItem item;
        final List<String> flags = new ArrayList<>();
        final List<JSONObject> candidates = new ArrayList<>();
        // Tagged boxes already RECORDED at this stray's home bin - the
        // keep-or-move question reads differently when the recommended
        // shelf provably holds stock.
        int recordBinTags;
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
    // held-trigger sweep (unreadable-label rescue)
    private boolean sweepArmed = false;
    private volatile boolean sweepRunning = false;

    private JSONObject stationProduct = null;
    private int stationTags = 0;
    private final ArrayDeque<String> stationHistory = new ArrayDeque<>();

    private final LinkedHashMap<String, Integer> tags = new LinkedHashMap<>();

    private final HashMap<String, Bitmap> imgCache = new HashMap<>();

    // ============================================================ onCreate ==
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // A crash while building the UI used to mean an app that simply
        // wouldn't open, with nothing to go on. Show the fault instead.
        try {
            buildUi(savedInstanceState);
        } catch (Throwable t) {
            showStartupFailure(t);
        }
    }

    private void showStartupFailure(Throwable t) {
        StringBuilder sb = new StringBuilder("TC RFID Sweep failed to "
                + "start.\n\n").append(t.toString()).append("\n");
        StackTraceElement[] trace = t.getStackTrace();
        for (int i = 0; i < Math.min(6, trace.length); i++) {
            sb.append("\n  at ").append(trace[i].toString());
        }
        TextView view = new TextView(this);
        view.setText(sb.toString());
        view.setTextSize(12);
        view.setPadding(dp(12), dp(12), dp(12), dp(12));
        view.setTextIsSelectable(true);
        setContentView(view);
    }

    private void buildUi(Bundle savedInstanceState) {
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
        // Context help: explains whatever screen (and batch step) is up.
        Button helpBtn = smallBtn("?");
        helpBtn.setOnClickListener(v -> showHelp());
        LinearLayout.LayoutParams hl = new LinearLayout.LayoutParams(
                dp(44), LinearLayout.LayoutParams.WRAP_CONTENT);
        hl.leftMargin = dp(4);
        header.addView(helpBtn, hl);

        // ---- shared scanner input + status --------------------------------
        btInput = new EditText(this);
        btInput.setHint("BT scanner…");
        btInput.setTextSize(13);
        btInput.setPadding(dp(10), dp(7), dp(10), dp(7));
        btInput.setBackground(rr(Color.WHITE, C_LINE, 8));
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
        status.setPadding(dp(10), dp(6), dp(10), dp(6));
        status.setMaxLines(3);
        status.setBackground(rr(Color.WHITE, C_LINE, 8));
        LinearLayout.LayoutParams sl = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT);
        sl.topMargin = dp(6);
        sl.bottomMargin = dp(6);
        root.addView(status, sl);

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

        // Which build is actually on this device. Read from the package
        // manager rather than a constant, so it can never disagree with the
        // APK that's installed - the whole point is to answer "did that
        // install take?" without guesswork.
        TextView ver = new TextView(this);
        ver.setText("TC RFID Sweep  v" + appVersion());
        ver.setTextSize(11);
        ver.setTextColor(Color.parseColor("#777777"));
        LinearLayout.LayoutParams vl = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT);
        vl.topMargin = dp(10);
        drawerPanel.addView(ver, vl);

        drawerScrim.addView(drawerPanel, new FrameLayout.LayoutParams(
                dp(210), FrameLayout.LayoutParams.MATCH_PARENT,
                Gravity.START));
        outer.addView(drawerScrim);

        buildItemEditor(outer);

        // Topmost veil: a spinner dead-centre while a network call runs, so
        // a slow check reads as "working…" instead of a frozen screen. Added
        // LAST so it draws over the drawer and the item editor too.
        loadingOverlay = new FrameLayout(this);
        loadingOverlay.setBackgroundColor(0x99000000);
        loadingOverlay.setClickable(true); // swallow taps while busy
        LinearLayout loadBox = new LinearLayout(this);
        loadBox.setOrientation(LinearLayout.VERTICAL);
        loadBox.setGravity(Gravity.CENTER_HORIZONTAL);
        android.widget.ProgressBar spin =
                new android.widget.ProgressBar(this);
        spin.setIndeterminate(true);
        loadBox.addView(spin, new LinearLayout.LayoutParams(dp(64), dp(64)));
        loadingText = new TextView(this);
        loadingText.setTextColor(Color.WHITE);
        loadingText.setTextSize(14);
        loadingText.setTypeface(null, Typeface.BOLD);
        loadingText.setGravity(Gravity.CENTER_HORIZONTAL);
        loadingText.setPadding(dp(24), dp(10), dp(24), 0);
        loadBox.addView(loadingText);
        loadingOverlay.addView(loadBox, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.WRAP_CONTENT,
                FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.CENTER));
        loadingOverlay.setVisibility(View.GONE);
        outer.addView(loadingOverlay, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT));

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
        // Tap the bin name to flag it "ask first" on the work list — for
        // shelves nobody should scan without a word with someone who knows
        // the stock better.
        binChip.setOnClickListener(view -> flagBinDialog());
        header.addView(binChip, weight());
        pwrChipBatch = chipBtn("PWR " + prefs.getInt("power", 5));
        wirePowerChip(pwrChipBatch);
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
        // Tapping the preview card edits the product it shows — no hunting
        // for the same item down in the list.
        batchCard.setOnClickListener(view -> {
            BItem it = focusedItem();
            if (it == null) return;
            CheckEntry e = new CheckEntry();
            e.item = it;
            openItemEditor(e);
        });
        v.addView(batchCard);

        batchListView = new ListView(this);
        batchAdapter = new BatchAdapter();
        batchListView.setAdapter(batchAdapter);
        batchListView.setDivider(null);
        batchListView.setDividerHeight(0);
        v.addView(batchListView, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f));

        // Steve's order: EXIT | BACK | BASELINE | UNDO | NEXT — escape on
        // the far left, the one advancing action on the far right.
        batchBtnRow = new LinearLayout(this);
        Button exit = smallBtn("EXIT");
        exit.setOnClickListener(x -> confirmExitBatch());
        batchBtnRow.addView(exit, weight());
        // Trailing arrow, like NEXT — on a five-button row both labels wrap,
        // and a leading arrow put BACK's above the word while NEXT's sat
        // below it.
        Button back = smallBtn("BACK ←");
        back.setOnClickListener(x -> stepBack());
        batchBtnRow.addView(back, weight());
        btnSweep = smallBtn("SWEEP");
        btnSweep.setOnClickListener(x -> {
            if (step == STEP_PAIR) armSweep();
            // COLLECT: baseline a part-tagged shelf. (Unpair-everything
            // stays reachable via long-press on UNDO.)
            else if (step == STEP_COLLECT) baselineButton();
            else undoAllPairing();
        });
        batchBtnRow.addView(btnSweep, weight());
        btnUndo = smallBtn("UNDO");
        btnUndo.setOnClickListener(x -> {
            if (step == STEP_VERIFY) clearVerifySweep();
            else undoPair();
        });
        btnUndo.setOnLongClickListener(x -> {
            undoAllPairing();
            return true;
        });
        batchBtnRow.addView(btnUndo, weight());
        btnNext = smallBtn("NEXT →");
        makePrimary(btnNext);   // the one button that advances the flow
        btnNext.setOnClickListener(x -> stepNext());
        batchBtnRow.addView(btnNext, weight());
        v.addView(batchBtnRow);

        batchListView.setOnItemClickListener((parent, view, pos, id) -> {
            if (!inBatch() || pos >= displayItems.size()) return;
            if (step == STEP_CHECK && pos < checkEntries.size()) {
                openItemEditor(checkEntries.get(pos));
            } else {
                // Same editor everywhere: fix a count, rename the label,
                // move a product or skip it — during collect, pair AND
                // verify, without hunting for the one step that allows it.
                CheckEntry e = new CheckEntry();
                e.item = displayItems.get(pos);
                openItemEditor(e);
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
        wirePowerChip(pwrChipStation);
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
        pwrChipSweep = chipBtn("PWR " + prefs.getInt("power", 5));
        wirePowerChip(pwrChipSweep);
        header.addView(pwrChipSweep);
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
                // Not a listing — but it may be a CASE code (a box of N of
                // one product). That is exactly the scan that used to come
                // back empty and leave someone holding an unplaceable box.
                JSONObject c = null;
                try {
                    c = api("GET", "/api/cases/"
                            + URLEncoder.encode(code, "UTF-8"), null);
                } catch (Exception ignored) {
                    // genuinely unknown; fall through to the error below
                }
                if (c != null) {
                    final JSONObject box = c;
                    ui.post(() -> showCaseFind(box));
                    return;
                }
                ui.post(() -> {
                    beep(SOUND_ERR);
                    findResult.setText("Not found:\n" + e.getMessage());
                    loadImage(null, findImg);
                    btInput.requestFocus();
                });
            }
        }).start();
    }

    /** A case code in FIND BIN: where the contents live, plus the note. */
    private void showCaseFind(JSONObject c) {
        JSONObject p = c.optJSONObject("product");
        String bin = p == null ? "" : p.optString("bin_location", "");
        boolean has = !bin.isEmpty()
                && !bin.equalsIgnoreCase("No bin assigned");
        int units = c.optInt("units", 0);
        String sku = c.optString("sku", "—");
        String title = c.isNull("product_title") ? ""
                : c.optString("product_title");
        String note = c.isNull("scan_note") ? "" : c.optString("scan_note");
        beep(SOUND_OTHER);
        findResult.setText(
                (has ? "BIN  " + bin : "NO BIN ASSIGNED")
                + "\n\nBOX OF " + units + "\n" + units + " x " + sku
                + (title.isEmpty() ? "" : "\n" + title)
                + (note.isEmpty() ? "" : "\n\n! " + note));
        findResult.setTextSize(has ? 20 : 16);
        loadImage(p == null || p.isNull("image_url") ? null
                : p.optString("image_url"), findImg);
        status.setText("That barcode is a box of " + units + ".");
        btInput.requestFocus();
    }

    // ---- LOCATE tab (design settled with Nick 2026-08-06): pick a
    // product by barcode/SKU, then hunt its tags by signal strength.
    // FAR/NEAR/TOUCH power presets, geiger audio, tap-to-narrow to one
    // tag, and a power-1 touch-read that CONFIRMS a find and drops that
    // tag out of the hunt so the next box can be chased. ----
    private ImageView locImg;
    private TextView locName, locSku, locPct, locInfo, locHint;
    private android.widget.ProgressBar locMeter;
    private Button locFar, locNear, locTouch, locSoundBtn, locTargetBtn,
            locFoundBtn;
    private JSONObject locProduct = null;
    private final java.util.LinkedHashMap<String, Double> locTags =
            new java.util.LinkedHashMap<>();   // EPC -> last rssi heard
    private final java.util.HashSet<String> locFound =
            new java.util.HashSet<>();
    private String locNarrow = null;           // one EPC, or null = all
    private volatile boolean locating = false;
    private boolean locSound = true;
    private int locPower = 30;
    private volatile double locBestRssi = -999; // best since last tick
    private volatile long locLastHeard = 0;
    private volatile int locHeardCount = 0;     // distinct targets heard
    private double locEma = 0;                  // smoothed 0..100

    private View buildLocateView() {
        LinearLayout v = new LinearLayout(this);
        v.setOrientation(LinearLayout.VERTICAL);
        v.setPadding(dp(12), dp(10), dp(12), dp(10));

        FrameLayout card = new FrameLayout(this);
        card.setBackground(rr(Color.WHITE, C_LINE, 10));
        card.setPadding(dp(10), dp(10), dp(10), dp(10));
        LinearLayout row = new LinearLayout(this);
        locImg = new ImageView(this);
        locImg.setScaleType(ImageView.ScaleType.CENTER_CROP);
        locImg.setBackgroundColor(C_BG);
        LinearLayout.LayoutParams il =
                new LinearLayout.LayoutParams(dp(56), dp(56));
        il.rightMargin = dp(10);
        row.addView(locImg, il);
        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        locName = new TextView(this);
        locName.setTextSize(15);
        locName.setTypeface(null, Typeface.BOLD);
        locName.setTextColor(C_TEXT);
        locName.setMaxLines(2);
        locName.setText("Scan or type a barcode / SKU");
        col.addView(locName);
        locSku = new TextView(this);
        locSku.setTextSize(12);
        locSku.setTextColor(C_MUTED);
        col.addView(locSku);
        row.addView(col, weight());
        card.addView(row);
        v.addView(card);

        locMeter = new android.widget.ProgressBar(this, null,
                android.R.attr.progressBarStyleHorizontal);
        locMeter.setMax(100);
        LinearLayout.LayoutParams ml = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, dp(26));
        ml.topMargin = dp(12);
        v.addView(locMeter, ml);

        locPct = new TextView(this);
        locPct.setTextSize(34);
        locPct.setTypeface(null, Typeface.BOLD);
        locPct.setTextColor(C_BLUE);
        locPct.setGravity(Gravity.CENTER);
        locPct.setText("—");
        v.addView(locPct);

        locInfo = new TextView(this);
        locInfo.setTextSize(12);
        locInfo.setTextColor(C_MUTED);
        locInfo.setGravity(Gravity.CENTER);
        v.addView(locInfo);

        LinearLayout pow = new LinearLayout(this);
        pow.setGravity(Gravity.CENTER);
        pow.setPadding(0, dp(10), 0, 0);
        locFar = smallBtn("FAR");
        locNear = smallBtn("NEAR");
        locTouch = smallBtn("TOUCH");
        locFar.setOnClickListener(x -> setLocPower(30, locFar));
        locNear.setOnClickListener(x -> setLocPower(12, locNear));
        locTouch.setOnClickListener(x -> setLocPower(5, locTouch));
        LinearLayout.LayoutParams pb = new LinearLayout.LayoutParams(
                0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f);
        pow.addView(locFar, pb);
        pow.addView(locNear, new LinearLayout.LayoutParams(
                0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
        pow.addView(locTouch, new LinearLayout.LayoutParams(
                0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
        v.addView(pow);

        LinearLayout act = new LinearLayout(this);
        act.setGravity(Gravity.CENTER);
        act.setPadding(0, dp(6), 0, 0);
        locSoundBtn = smallBtn("🔊 ON");
        locSoundBtn.setOnClickListener(x -> {
            locSound = !locSound;
            locSoundBtn.setText(locSound ? "🔊 ON" : "🔇 OFF");
        });
        locTargetBtn = smallBtn("TARGET…");
        locTargetBtn.setOnClickListener(x -> locateTargetDialog());
        locFoundBtn = smallBtn("FOUND IT?");
        locFoundBtn.setOnClickListener(x -> confirmFoundScan());
        act.addView(locSoundBtn, new LinearLayout.LayoutParams(
                0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
        act.addView(locTargetBtn, new LinearLayout.LayoutParams(
                0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
        act.addView(locFoundBtn, new LinearLayout.LayoutParams(
                0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
        v.addView(act);

        locHint = new TextView(this);
        locHint.setTextSize(11);
        locHint.setTextColor(C_MUTED);
        locHint.setGravity(Gravity.CENTER);
        locHint.setPadding(0, dp(8), 0, 0);
        locHint.setText("Trigger toggles the hunt. Signal pegged? Drop to "
                + "NEAR, then TOUCH. FOUND IT? reads at power 1 with the "
                + "antenna touching the sticker, and drops that tag out "
                + "of the hunt.");
        v.addView(locHint);
        return v;
    }

    private void setLocPower(int power, Button active) {
        locPower = power;
        for (Button b : new Button[]{locFar, locNear, locTouch}) {
            b.setTextColor(b == active ? C_BLUE : C_TEXT);
        }
        if (locating && reader != null) {
            try {
                reader.setPower(power);
            } catch (Exception ignored) {
            }
        }
        status.setText("Locate power " + power
                + (power <= 5 ? " — only answers within arm's reach."
                   : power <= 12 ? " — a shelf bay or two."
                   : " — the whole aisle answers."));
    }

    /** Resolve a scan/typed code into the product + its tags on file. */
    private void locateLookup(String code) {
        status.setText("Looking up " + code + "…");
        new Thread(() -> {
            try {
                JSONObject product = null;
                try {
                    product = api("GET", "/api/products/by-barcode/"
                            + URLEncoder.encode(code, "UTF-8"), null);
                } catch (Exception ignored) {
                    // Not in the catalog under that code — the tags call
                    // below still matches raw SKU/barcode on tags.
                }
                String sku = product != null && !product.isNull("sku")
                        ? product.optString("sku") : code;
                String bc = product != null && !product.isNull("barcode")
                        ? product.optString("barcode") : code;
                JSONObject tagsResp = api("GET", "/api/products/tags?sku="
                        + URLEncoder.encode(sku, "UTF-8") + "&barcode="
                        + URLEncoder.encode(bc, "UTF-8"), null);
                final JSONObject fp = product;
                final org.json.JSONArray rows =
                        tagsResp.optJSONArray("assignments");
                ui.post(() -> {
                    stopLocate(false);
                    locTags.clear();
                    locFound.clear();
                    locNarrow = null;
                    locEma = 0;
                    locProduct = null;
                    if (rows == null || rows.length() == 0) {
                        beep(SOUND_ERR);
                        locName.setText(fp != null
                                ? fp.optString("product_title", code) : code);
                        locSku.setText("No RFID tags on file — nothing to "
                                + "hunt.");
                        locImg.setImageBitmap(null);
                        updateLocateUi();
                        return;
                    }
                    JSONObject first = rows.optJSONObject(0);
                    locProduct = fp != null ? fp : first;
                    for (int i = 0; i < rows.length(); i++) {
                        JSONObject a = rows.optJSONObject(i);
                        String epc = a == null ? null : a.optString("rfid_id");
                        if (epc != null && !epc.isEmpty()) {
                            locTags.put(epc.toUpperCase(
                                    java.util.Locale.ROOT), -999.0);
                        }
                    }
                    beep(SOUND_OK);
                    locName.setText(locProduct.optString("product_title",
                            code));
                    String bin = first == null || first.isNull("bin_location")
                            ? null : first.optString("bin_location");
                    locSku.setText("SKU: " + sku
                            + (bin != null ? "  ·  Bin: " + bin : "")
                            + "  ·  " + locTags.size() + " tag(s) on file");
                    loadImage(locProduct.isNull("image_url") ? null
                            : locProduct.optString("image_url"), locImg);
                    updateLocateUi();
                    status.setText("Pull the trigger to hunt "
                            + locTags.size() + " tag(s).");
                });
            } catch (Exception e) {
                ui.post(() -> {
                    beep(SOUND_ERR);
                    status.setText("Lookup failed: " + e.getMessage());
                });
            }
        }).start();
    }

    /** The EPCs the meter currently listens for. */
    private java.util.Set<String> locTargets() {
        java.util.HashSet<String> t = new java.util.HashSet<>();
        if (locNarrow != null) {
            t.add(locNarrow);
        } else {
            t.addAll(locTags.keySet());
            t.removeAll(locFound);
        }
        return t;
    }

    private void toggleLocate() {
        if (locProduct == null || locTags.isEmpty()) {
            beep(SOUND_ERR);
            status.setText("Scan or type a product barcode/SKU first.");
            return;
        }
        if (locating) {
            stopLocate(true);
            return;
        }
        if (locTargets().isEmpty()) {
            beep(SOUND_ERR);
            status.setText("Every tag is marked found — RESET via "
                    + "TARGET… to hunt them again.");
            return;
        }
        try {
            reader.setPower(locPower);
            reader.startInventoryTag();
            locating = true;
            locEma = 0;
            locBestRssi = -999;
            scheduleLocateBeep();
            status.setText("Hunting… trigger again to stop.");
        } catch (Exception e) {
            status.setText("Reader failed: " + e.getMessage());
        }
    }

    private void stopLocate(boolean announce) {
        if (locating) {
            locating = false;
            try {
                reader.stopInventory();
            } catch (Exception ignored) {
            }
            try {
                // Hand the radio back the way other modes expect it.
                reader.setPower(prefs.getInt("power", 20));
            } catch (Exception ignored) {
            }
            if (announce) status.setText("Hunt paused.");
        }
    }

    /** Called from the SDK callback thread for every read while locating. */
    private void onLocateRead(String epc, double rssi) {
        String key = epc.toUpperCase(java.util.Locale.ROOT);
        if (!locTags.containsKey(key)) return;
        locTags.put(key, rssi);
        if (!locTargets().contains(key)) return;
        long now = System.currentTimeMillis();
        if (rssi > locBestRssi || now - locLastHeard > 700) {
            locBestRssi = rssi;
        }
        locLastHeard = now;
    }

    private static double locPctOf(double rssi) {
        if (rssi <= -998) return 0;
        double pct = (rssi + 75) / 45 * 100;
        return Math.max(0, Math.min(100, pct));
    }

    /** 400 ms UI pulse driven from refreshTick. */
    private void locateTick() {
        if (activeTab != TAB_LOCATE || locProduct == null) return;
        long now = System.currentTimeMillis();
        boolean fresh = locating && now - locLastHeard < 1200;
        if (fresh) {
            locEma = 0.5 * locEma + 0.5 * locPctOf(locBestRssi);
        } else {
            locEma *= 0.7;   // fade rather than snap when the tag goes quiet
        }
        int pct = (int) Math.round(locEma);
        locMeter.setProgress(pct);
        locPct.setText(locating
                ? pct + "%" + (fresh ? "" : " · quiet") : "—");
        int heard = 0;
        for (java.util.Map.Entry<String, Double> e : locTags.entrySet()) {
            if (e.getValue() > -998) heard++;
        }
        locHeardCount = heard;
        locBestRssi = -999;   // best-of-window resets each tick
        updateLocateUi();
    }

    private void updateLocateUi() {
        if (locInfo == null) return;
        if (locProduct == null || locTags.isEmpty()) {
            locInfo.setText("");
            return;
        }
        locInfo.setText((locNarrow != null
                ? "targeting ONE tag …" + locNarrow.substring(
                        Math.max(0, locNarrow.length() - 6))
                : "targeting " + locTargets().size() + " tag(s)")
                + " · heard " + locHeardCount + " of " + locTags.size()
                + " ever · " + locFound.size() + " found ✓"
                + " · power " + locPower);
    }

    /** Geiger cadence: silence when quiet, ~1 Hz far away, ~10 Hz on top
     *  of it. Self-reschedules while the hunt runs. */
    private void scheduleLocateBeep() {
        if (!locating) return;
        long delay = 300;
        boolean fresh = System.currentTimeMillis() - locLastHeard < 1200;
        if (fresh && locEma > 3) {
            delay = (long) Math.max(90, 1000 - locEma * 9);
            if (locSound && tones != null) {
                try {
                    tones.startTone(ToneGenerator.TONE_PROP_BEEP, 40);
                } catch (Exception ignored) {
                }
            }
        }
        ui.postDelayed(this::scheduleLocateBeep, delay);
    }

    /** Which tag(s) to chase: all remaining, one specific, or un-find a
     *  found one to hunt it again. */
    private void locateTargetDialog() {
        if (locTags.isEmpty()) return;
        final List<String> labels = new ArrayList<>();
        final List<String> epcs = new ArrayList<>();
        labels.add("ALL remaining tags (" + Math.max(0,
                locTags.size() - locFound.size()) + ")");
        epcs.add(null);
        for (String epc : locTags.keySet()) {
            String tail = "…" + epc.substring(Math.max(0, epc.length() - 6));
            labels.add(tail + (locFound.contains(epc)
                    ? "  — found ✓ (tap to hunt again)"
                    : locNarrow != null && locNarrow.equals(epc)
                      ? "  — current target" : ""));
            epcs.add(epc);
        }
        labels.add("RESET all found marks");
        epcs.add("RESET");
        new AlertDialog.Builder(this)
                .setTitle("Target which tag?")
                .setItems(labels.toArray(new String[0]), (d, which) -> {
                    String pick = epcs.get(which);
                    if ("RESET".equals(pick)) {
                        locFound.clear();
                        locNarrow = null;
                        status.setText("Found marks cleared — hunting "
                                + "every tag again.");
                    } else if (pick == null) {
                        locNarrow = null;
                    } else {
                        locFound.remove(pick);
                        locNarrow = pick;
                    }
                    updateLocateUi();
                })
                .setNegativeButton("Cancel", null)
                .show();
    }

    /** Nick's confirm-a-find: pause the hunt, read at power 1 with the
     *  antenna against the sticker, and if it's one of the product's tags
     *  mark it FOUND and drop it from the hunt — then chase the next box. */
    private void confirmFoundScan() {
        if (locProduct == null || locTags.isEmpty()) {
            status.setText("Nothing being hunted.");
            return;
        }
        final boolean wasLocating = locating;
        stopLocate(false);
        status.setText("Touch the antenna to the sticker…");
        locFoundBtn.setEnabled(false);
        new Thread(() -> {
            String hit = null;
            double hitRssi = -999;
            boolean strange = false;
            try {
                try {
                    reader.setPower(1);
                } catch (Exception ignored) {
                    reader.setPower(2);
                }
                long until = System.currentTimeMillis() + 2000;
                while (System.currentTimeMillis() < until) {
                    UHFTAGInfo info = null;
                    try {
                        info = reader.inventorySingleTag();
                    } catch (Exception ignored) {
                    }
                    if (info == null) continue;
                    String epc = info.getEPC();
                    if (epc == null || epc.isEmpty()) continue;
                    String key = epc.toUpperCase(java.util.Locale.ROOT);
                    if (locTags.containsKey(key)) {
                        double r = -999;
                        try {
                            r = Double.parseDouble(info.getRssi());
                        } catch (Exception ignored) {
                        }
                        if (hit == null || r > hitRssi) {
                            hit = key;
                            hitRssi = r;
                        }
                    } else {
                        strange = true;
                    }
                }
            } catch (Exception ignored) {
            } finally {
                try {
                    reader.setPower(locPower);
                } catch (Exception ignored) {
                }
            }
            final String fhit = hit;
            final boolean fstrange = strange;
            ui.post(() -> {
                locFoundBtn.setEnabled(true);
                if (fhit != null) {
                    boolean already = locFound.contains(fhit);
                    locFound.add(fhit);
                    if (fhit.equals(locNarrow)) locNarrow = null;
                    beep(SOUND_OK);
                    status.setText((already ? "Same tag again (…"
                            : "Found ✓ …")
                            + fhit.substring(Math.max(0, fhit.length() - 6))
                            + " — " + locFound.size() + " of "
                            + locTags.size() + " found; out of the hunt.");
                    if (wasLocating && !locTargets().isEmpty()) {
                        toggleLocate();
                    }
                } else {
                    beep(SOUND_ERR);
                    status.setText(fstrange
                            ? "Read a tag, but not one of this product's."
                            : "Nothing read — hold the antenna against "
                              + "the sticker and try again.");
                    if (wasLocating) toggleLocate();
                }
                updateLocateUi();
            });
        }).start();
    }

    // Preview card: [image | name + SKU] with the tracker pinned top-right.
    private void buildCard(FrameLayout card, ImageView[] img, TextView[] name,
                           TextView[] sku, TextView[] tracker) {
        card.setBackground(rr(Color.WHITE, C_LINE, 10));
        card.setPadding(dp(10), dp(10), dp(10), dp(10));

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

    /** Rounded rect: the building block of the whole look. */
    private GradientDrawable rr(int fill, int stroke, int radiusDp) {
        GradientDrawable g = new GradientDrawable();
        g.setColor(fill);
        g.setCornerRadius(dp(radiusDp));
        if (stroke != 0) g.setStroke(dp(1), stroke);
        return g;
    }

    /** Button background with a real pressed state — a flat drawable would
     *  kill all touch feedback, which on a scanner is how double-taps
     *  happen. */
    private StateListDrawable btnBg(int fill, int stroke, int pressed,
                                    int radiusDp) {
        StateListDrawable s = new StateListDrawable();
        s.addState(new int[]{android.R.attr.state_pressed},
                rr(pressed, stroke, radiusDp));
        s.addState(new int[]{}, rr(fill, stroke, radiusDp));
        return s;
    }

    private Button smallBtn(String text) {
        Button b = new Button(this);
        b.setText(text);
        b.setTextSize(12);
        b.setAllCaps(false);
        b.setMinHeight(0);
        b.setMinimumHeight(dp(38));
        b.setPadding(dp(10), 0, dp(10), 0);
        b.setBackground(btnBg(Color.WHITE, C_LINE, C_PRESS, 8));
        b.setTextColor(C_TEXT);
        b.setStateListAnimator(null);
        return b;
    }

    /** The one action that moves the flow forward gets the filled blue. */
    private void makePrimary(Button b) {
        b.setBackground(btnBg(C_BLUE, 0, C_BLUE_DK, 8));
        b.setTextColor(Color.WHITE);
        b.setTypeface(null, Typeface.BOLD);
    }

    private Button chipBtn(String text) {
        Button b = smallBtn(text);
        b.setBackground(btnBg(C_SOFT, 0, C_SOFT_DK, 16));
        b.setTextColor(C_BLUE);
        b.setTypeface(null, Typeface.BOLD);
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
    private Button editBinTripBtn;
    private Button editBinChip;
    private LinearLayout editLabelRow;
    private Button editLabelMode;
    private EditText editLabelText;
    private Button editDropBtn;
    private Button editFindBtn;
    private Button editRecommendBtn;
    private Button editSkipBtn;
    private Button editNoScanBtn;
    private Button editPriorBtn;
    private Button editDblBtn;
    private Button editSplitBtn;

    private void buildItemEditor(FrameLayout outer) {
        editScrim = new FrameLayout(this);
        editScrim.setBackgroundColor(Color.parseColor("#99000000"));
        editScrim.setVisibility(View.GONE);
        editScrim.setOnClickListener(v -> closeItemEditor());

        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setBackground(rr(Color.WHITE, C_LINE, 12));
        panel.setPadding(dp(12), dp(12), dp(12), dp(12));
        panel.setClickable(true);

        // Candidate arrows sit ON the preview image, left and right, rather
        // than running the full height of the panel: they belong to the
        // product being shown, and full-height rails stole width from every
        // control below them.
        FrameLayout imgWrap = new FrameLayout(this);
        editImg = new ImageView(this);
        editImg.setScaleType(ImageView.ScaleType.FIT_CENTER);
        editImg.setBackground(rr(C_BG, 0, 8));
        imgWrap.addView(editImg, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, dp(96)));

        editPrev = smallBtn("◀");
        editPrev.setTextSize(17);
        editPrev.setOnClickListener(v -> {
            if (editIdx > 0) {
                editIdx--;
                renderItemEditor();
            }
        });
        FrameLayout.LayoutParams pvl = new FrameLayout.LayoutParams(
                dp(40), dp(56), Gravity.START | Gravity.CENTER_VERTICAL);
        imgWrap.addView(editPrev, pvl);

        editNext = smallBtn("▶");
        editNext.setTextSize(17);
        editNext.setOnClickListener(v -> {
            if (editEntry != null
                    && editIdx < editEntry.candidates.size() - 1) {
                editIdx++;
                renderItemEditor();
            }
        });
        FrameLayout.LayoutParams nxl = new FrameLayout.LayoutParams(
                dp(40), dp(56), Gravity.END | Gravity.CENTER_VERTICAL);
        imgWrap.addView(editNext, nxl);
        Button editHelp = smallBtn("?");
        editHelp.setOnClickListener(v -> showEditorHelp());
        imgWrap.addView(editHelp, new FrameLayout.LayoutParams(
                dp(34), dp(34), Gravity.END | Gravity.TOP));
        panel.addView(imgWrap);

        LinearLayout mid = new LinearLayout(this);
        mid.setOrientation(LinearLayout.VERTICAL);
        // Uniform breathing room between every block — the old panel packed
        // a dozen controls edge-to-edge, which is most of what made it feel
        // broken.
        GradientDrawable midGap = new GradientDrawable();
        midGap.setSize(0, dp(8));
        mid.setShowDividers(LinearLayout.SHOW_DIVIDER_MIDDLE);
        mid.setDividerDrawable(midGap);
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
        makePrimary(editUse);   // the decisive action when listings compete
        editUse.setOnClickListener(v -> reassignToShown());
        mid.addView(editUse);

        // Some boxes are one listing and some another (open box vs regular,
        // same barcode) — divide the count instead of moving all of it.
        editSplitBtn = smallBtn("SPLIT BETWEEN LISTINGS");
        editSplitBtn.setOnClickListener(v -> openSplitDialog());
        mid.addView(editSplitBtn);
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

        // Bin chip — always available, not just when the bin looks wrong.
        editBinChip = smallBtn("BIN");
        editBinChip.setOnClickListener(v -> changeBinDialog());
        mid.addView(editBinChip);

        // Wrong shelf: move it, drop it, or ignore for this batch.
        editBinRow = new LinearLayout(this);
        editBinRow.setOrientation(LinearLayout.VERTICAL);
        editBinText = new TextView(this);
        editBinText.setTextSize(13);
        editBinText.setTextColor(Color.parseColor("#8a6116"));
        editBinRow.addView(editBinText);
        // The productive answer gets its own full-width line: physically
        // carry the box(es) to the shelf the record names, as a side trip —
        // labels print with THAT bin, pair there, come straight back.
        // Works from inside a side trip too (the EFW mask case); the
        // server chains the batches.
        editBinTripBtn = smallBtn("Take it there");
        editBinTripBtn.setOnClickListener(v -> tripFromItem());
        LinearLayout.LayoutParams tripLp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT);
        tripLp.topMargin = dp(4);
        tripLp.bottomMargin = dp(4);
        editBinRow.addView(editBinTripBtn, tripLp);
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

        // Unresolved barcode rescue, so an unknown box can be sorted out at
        // the shelf instead of walking back to the desk. Same two routes the
        // web offers: the one product this bin most likely means, or every
        // product here with an odd-looking barcode.
        editFindBtn = smallBtn("FIND IT IN THIS BIN");
        editFindBtn.setOnClickListener(v -> loadOddCandidates(false));
        mid.addView(editFindBtn);

        editRecommendBtn = smallBtn("SHOW RECOMMENDED");
        editRecommendBtn.setOnClickListener(v -> loadOddCandidates(true));
        mid.addView(editRecommendBtn);

        // "I can't do this one." Keeps the row and the reason; prints no
        // label; changes no count anywhere.
        editSkipBtn = smallBtn("CAN'T SCAN — SKIP");
        editSkipBtn.setOnClickListener(v -> {
            if (editEntry != null && editEntry.item.skipped) setItemSkip(false, null);
            else askSkipReason();
        });
        mid.addView(editSkipBtn);

        // Product-wide "won't RFID scan": labels still print, pairing
        // still counts — sweeps just stop expecting an answer. Applies to
        // the PRODUCT (every box shares the tag-killing design).
        editNoScanBtn = smallBtn("WON'T RFID SCAN");
        editNoScanBtn.setOnClickListener(v -> toggleNoScan());
        mid.addView(editNoScanBtn);

        // "Some of these boxes already wear a sticker" — the same answer
        // the first-scan question sets, reachable again here for the shelf
        // where EVERY box was already tagged and nothing gets scanned.
        editPriorBtn = smallBtn("ALREADY TAGGED…");
        editPriorBtn.setOnClickListener(v -> {
            if (editEntry != null) {
                showAlreadyTaggedDialog(editEntry.item, false);
            }
        });
        mid.addView(editPriorBtn);

        // One-tap fix for the double-count flag: the stickered boxes were
        // barcode-scanned too, so the scan count drops by that many.
        // Local batch numbers only — nothing writes to Shopify.
        editDblBtn = smallBtn("REMOVE DOUBLE COUNT");
        editDblBtn.setOnClickListener(v -> {
            if (editEntry == null) return;
            BItem it = editEntry.item;
            int fixed = Math.max(0, it.qty - it.taggedBefore);
            new AlertDialog.Builder(this)
                    .setTitle("Remove the double count?")
                    .setMessage(it.qty + " scanned + " + it.taggedBefore
                            + " already tagged — if the " + it.taggedBefore
                            + " stickered box(es) were among the scans, "
                            + "the true split is " + fixed + " new + "
                            + it.taggedBefore + " tagged.\n\nBatch counts "
                            + "only; Shopify is untouched.")
                    .setPositiveButton("SET SCANNED TO " + fixed,
                            (d, w) -> setItemQty(it, fixed))
                    .setNegativeButton("Cancel", null)
                    .show();
        });
        mid.addView(editDblBtn);

        editDropBtn = smallBtn("REMOVE THIS SCAN");
        editDropBtn.setOnClickListener(v -> dropItemFromBatch(true));
        mid.addView(editDropBtn);

        LinearLayout qtyRow = new LinearLayout(this);
        qtyRow.setGravity(Gravity.CENTER);
        Button minus = smallBtn("−");
        minus.setOnClickListener(v -> editorAdjust(-1));
        qtyRow.addView(minus, new LinearLayout.LayoutParams(dp(52),
                LinearLayout.LayoutParams.WRAP_CONTENT));
        editQty = new TextView(this);
        editQty.setTextSize(18);
        editQty.setTypeface(null, Typeface.BOLD);
        editQty.setTextColor(C_BLUE);
        editQty.setGravity(Gravity.CENTER);
        // Tap the number to type an exact count — thirty taps of "+" is
        // no way to correct a big shelf.
        editQty.setOnClickListener(v -> exactCountDialog());
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
        // Scrolls: with the label editor, bin warning and rescue buttons all
        // visible at once, the old fixed panel simply ran off the screen.
        ScrollView midScroll = new ScrollView(this);
        midScroll.setVerticalScrollBarEnabled(false);
        midScroll.addView(mid);
        // Full width now that the arrows have moved onto the image.
        LinearLayout.LayoutParams msl = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT);
        msl.topMargin = dp(8);
        panel.addView(midScroll, msl);

        FrameLayout.LayoutParams pl = new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.CENTER);
        pl.leftMargin = dp(10);
        pl.rightMargin = dp(10);
        pl.topMargin = dp(16);
        pl.bottomMargin = dp(16);
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
        if (inBatch() && step == STEP_COLLECT) {
            refreshBatchList();
            btInput.requestFocus(); // straight back to scanning
        }
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
        editFlags.setVisibility(editEntry.flags.isEmpty()
                ? View.GONE : View.VISIBLE);
        editFlags.setText("⚠ " + flagText(editEntry.flags));
        editBinChip.setVisibility(it.resolved ? View.VISIBLE : View.GONE);
        editBinChip.setText("BIN: "
                + (it.binLocation == null || it.binLocation.isEmpty()
                   ? "none" : it.binLocation) + "   ✎ change");
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
            // Splitting needs at least two boxes to divide and no tags
            // yet — the server refuses both anyway, but a button that can
            // only fail is worse than no button.
            editSplitBtn.setVisibility(it.qty > 1 && it.paired == 0
                    && !it.skipped ? View.VISIBLE : View.GONE);
        } else {
            editPos.setVisibility(View.GONE);
            editUse.setVisibility(View.GONE);
            editSplitBtn.setVisibility(View.GONE);
        }
        editNameRow.setVisibility(
                editEntry.flags.contains("unconfirmed-name")
                        ? View.VISIBLE : View.GONE);
        boolean wrongBin = editEntry.flags.contains("wrong-bin");
        editBinRow.setVisibility(wrongBin ? View.VISIBLE : View.GONE);
        if (wrongBin) {
            editBinText.setText("On this shelf (" + batchBin + ") but the "
                    + "system has it in " + it.binLocation + ".");
            String home = firstBin(it.binLocation);
            editBinTripBtn.setText("TAKE IT TO " + home
                    + " — start a trip");
            // A trip needs boxes to carry and no tags tying them here yet.
            editBinTripBtn.setVisibility(home != null && it.qty > 0
                    && it.paired == 0 ? View.VISIBLE : View.GONE);
        }
        editLabelRow.setVisibility(
                it.resolved && !it.skipped ? View.VISIBLE : View.GONE);
        editDropBtn.setVisibility(it.resolved ? View.GONE : View.VISIBLE);
        // Only a real product can be skipped; an unknown barcode already has
        // its own rescue route.
        editSkipBtn.setVisibility(it.resolved ? View.VISIBLE : View.GONE);
        editSkipBtn.setText(it.skipped
                ? "PUT IT BACK IN THE BATCH" : "CAN'T SCAN — SKIP");
        editNoScanBtn.setVisibility(
                it.resolved && it.sku != null ? View.VISIBLE : View.GONE);
        editNoScanBtn.setText(it.noScan
                ? "⊘ RFID FLAG ON — REMOVE" : "WON'T RFID SCAN");
        // Only while the count still matters (labels not queued yet) and
        // only when there ARE earlier tags to account for.
        editPriorBtn.setVisibility(it.resolved && step <= STEP_CHECK
                && (it.priorTags > 0 || it.taggedBefore > 0)
                ? View.VISIBLE : View.GONE);
        editPriorBtn.setText(it.taggedBefore > 0
                ? "✓ " + it.taggedBefore + " ALREADY TAGGED — CHANGE…"
                : "ALREADY TAGGED…");
        editDblBtn.setVisibility(it.resolved && it.qty > 0
                && it.taggedBefore > 0 ? View.VISIBLE : View.GONE);
        editDblBtn.setText("REMOVE DOUBLE COUNT (−" + it.taggedBefore
                + ")");
        // Only an unresolved row has a barcode to give away.
        editFindBtn.setVisibility(it.resolved ? View.GONE : View.VISIBLE);
        editRecommendBtn.setVisibility(it.resolved ? View.GONE : View.VISIBLE);
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
                                .put("bin", batchBin)
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
            else if ("not-on-shelf".equals(f)) sb.append("expected here "
                    + "per Shopify - none scanned; likely in another bin");
            else if ("double-count".equals(f)) sb.append("scanned AND "
                    + "marked already-tagged - stickered boxes may be "
                    + "counted twice");
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

    // Point this product at any bin — writes the same audited Shopify bin
    // update the Scan Station uses (shows in History).
    private void changeBinDialog() {
        if (editEntry == null || !editEntry.item.resolved) return;
        final BItem it = editEntry.item;
        final EditText in = new EditText(this);
        in.setHint("Bin, e.g. D2-2");
        in.setText(it.binLocation == null || "No bin assigned"
                .equalsIgnoreCase(it.binLocation) ? batchBin : it.binLocation);
        in.setSelectAllOnFocus(true);
        int pad = dp(16);
        in.setPadding(pad, pad, pad, pad);
        new AlertDialog.Builder(this)
                .setTitle("Change bin for " + it.name())
                .setView(in)
                .setPositiveButton("Save to Shopify", (d, w) -> {
                    final String bin = in.getText().toString().trim();
                    if (bin.isEmpty()) return;
                    new AlertDialog.Builder(this)
                            .setMessage("Set this product's bin in Shopify "
                                    + "to " + bin + "?\n\nWas: "
                                    + (it.binLocation == null ? "none"
                                       : it.binLocation))
                            .setPositiveButton("Yes, change it",
                                    (d2, w2) -> applyBinChange(it, bin))
                            .setNegativeButton("Cancel", null)
                            .show();
                })
                .setNegativeButton("Cancel", null)
                .show();
    }

    private void applyBinChange(BItem it, String bin) {
        new Thread(() -> {
            try {
                JSONObject body = new JSONObject()
                        .put("target", it.sku != null ? it.sku : it.barcode)
                        .put("bin", bin)
                        .put("changed_by", prefs.getString("device", "C72"));
                api("POST", "/api/bin-updates", body);
                ui.post(() -> {
                    beep(SOUND_OK);
                    it.binLocation = bin;
                    // The server now agrees, so the LOCAL flags must too —
                    // this used to leave "wrong-bin" stuck in the check
                    // list after a successful bin move (Nick, 2026-08-06).
                    if (editEntry != null && editEntry.item.id == it.id) {
                        if (bin.equalsIgnoreCase(batchBin)) {
                            editEntry.flags.remove("wrong-bin");
                        } else if (!editEntry.flags.contains("wrong-bin")) {
                            editEntry.flags.add("wrong-bin");
                        }
                        if (editEntry.flags.isEmpty()) {
                            checkEntries.remove(editEntry);
                            checkFlagText.remove(it.id);
                        } else {
                            checkFlagText.put(it.id,
                                    "⚠ " + flagText(editEntry.flags));
                        }
                    }
                    editMsg.setText("Bin set to " + bin + " ✓");
                    renderItemEditor();
                    status.setText(it.name() + " → bin " + bin);
                    reloadBatchOnly();
                    refreshBatchList();
                });
            } catch (Exception e) {
                ui.post(() -> {
                    beep(SOUND_ERR);
                    editMsg.setText(e.getMessage());
                });
            }
        }).start();
    }

    private void exactCountDialog() {
        if (editEntry == null) return;
        final BItem it = editEntry.item;
        final EditText in = new EditText(this);
        in.setInputType(android.text.InputType.TYPE_CLASS_NUMBER);
        in.setText(String.valueOf(it.qty));
        in.setSelectAllOnFocus(true);
        int pad = dp(16);
        in.setPadding(pad, pad, pad, pad);
        new AlertDialog.Builder(this)
                .setTitle("Boxes scanned for " + it.name())
                .setView(in)
                .setPositiveButton("Set", (d, w) -> {
                    try {
                        setItemQty(it, Math.max(0,
                                Integer.parseInt(
                                        in.getText().toString().trim())));
                    } catch (NumberFormatException ignored) {
                    }
                })
                .setNegativeButton("Cancel", null)
                .show();
    }

    private void editorAdjust(int delta) {
        if (editEntry == null) return;
        setItemQty(editEntry.item, Math.max(0, editEntry.item.qty + delta));
    }

    private void setItemQty(BItem item, int qty) {
        final BItem it = item;
        new Thread(() -> {
            try {
                JSONObject body = new JSONObject().put("qty", qty);
                JSONObject resp = api("POST", "/api/batches/" + batchId
                        + "/items/" + it.id + "/qty", body);
                final BItem updated = BItem.from(resp);
                ui.post(() -> {
                    if (editEntry != null) editEntry.item = updated;
                    BItem inList = itemById(updated.id);
                    if (inList != null) {
                        bItems.set(bItems.indexOf(inList), updated);
                        if (previewItem == inList) previewItem = updated;
                        if (pairActive == inList) pairActive = updated;
                    }
                    renderItemEditor();
                    // Keep the list behind the editor honest too.
                    refreshBatchList();
                    updateBatchCard();
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
            tabBtns[i].setBackground(i == activeTab
                    ? btnBg(C_BLUE, 0, C_BLUE_DK, 8)
                    : btnBg(Color.WHITE, C_LINE, C_PRESS, 8));
            tabBtns[i].setTextColor(i == activeTab ? Color.WHITE : C_TEXT);
            tabBtns[i].setTypeface(null,
                    i == activeTab ? Typeface.BOLD : Typeface.NORMAL);
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
        // Leaving locate always parks the radio (no-op when idle).
        if (tab != TAB_LOCATE) stopLocate(false);
        boolean needsInput = tab == TAB_BATCH || tab == TAB_STATION
                || tab == TAB_FIND || tab == TAB_LOCATE;
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
            status.setText(locProduct == null
                    ? "LOCATE: scan or type a product barcode/SKU."
                    : "LOCATE: trigger to hunt, FOUND IT? to confirm a "
                      + "find.");
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
                // A bin barcode with no batch open = "start one here" —
                // the same shortcut the Scan Station's bin scan gives.
                if (looksLikeBin(code)) {
                    askStartBatch(code.trim()
                            .toUpperCase(java.util.Locale.ROOT));
                } else {
                    beep(SOUND_ERR);
                    status.setText("Scan a BIN barcode (like D1-3) to "
                            + "start a batch there, or BATCH… to resume "
                            + "an open one.");
                }
                return;
            }
            if (step == STEP_PAIR) pairSelect(code);
            else if (step == STEP_CHECK) {
                beep(SOUND_ERR);
                status.setText("CHECK step — tap flagged items to review, "
                        + "or BACK to keep scanning.");
            } else batchScan(code);
        } else if (activeTab == TAB_LOCATE) {
            locateLookup(code);
        } else if (activeTab == TAB_STATION) {
            // The bins wear barcodes of their own that scan as the bin
            // name ("D1-3"). With a product already up, that scan almost
            // always means "this product lives HERE now" — but a few SKUs
            // look like bin names too, so it ASKS instead of assuming.
            if (stationProduct != null && looksLikeBin(code)) {
                askBinRelocate(code);
            } else {
                stationLookup(code);
            }
        } else if (activeTab == TAB_FIND) {
            findLookup(code);
        } else {
            status.setText("Scanned " + code + " — switch to BATCH, "
                    + "STATION or FIND BIN to use barcodes.");
        }
    }

    private static boolean isTriggerKey(int keyCode) {
        for (int k : TRIGGER_KEYS) if (keyCode == k) return true;
        return false;
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (isTriggerKey(keyCode)) {
            if (event.getRepeatCount() == 0) {
                // Armed sweep runs for exactly as long as the trigger is
                // held; everything else is a single pull.
                if (sweepArmed && activeTab == TAB_BATCH
                        && inBatch() && step == STEP_PAIR) {
                    startHeldSweep();
                } else {
                    onTrigger();
                }
            }
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    public boolean onKeyUp(int keyCode, KeyEvent event) {
        if (isTriggerKey(keyCode)) {
            if (sweepRunning) stopHeldSweep();
            return true;
        }
        return super.onKeyUp(keyCode, event);
    }

    private void onTrigger() {
        if (activeTab == TAB_BATCH) {
            if (inBatch() && step == STEP_PAIR) {
                pairReadTag();
            } else if (inBatch() && step == STEP_VERIFY) {
                toggleScan();   // same bulk sweep as the SWEEP tab
            } else if (inBatch() && baselineArmed) {
                toggleScan();   // baseline sweep of a part-tagged shelf
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
        } else if (activeTab == TAB_LOCATE) {
            toggleLocate();
        } else {
            status.setText("Nothing to trigger on this tab.");
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
                    if (locating) {
                        double rssi = -999;
                        try {
                            rssi = Double.parseDouble(info.getRssi());
                        } catch (Exception ignored2) {
                        }
                        onLocateRead(epc, rssi);
                        return;
                    }
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
        boolean fav = favPowers().contains(lv);
        String text = "PWR " + lv + (fav ? " ★" : "");
        pwrChipBatch.setText(text);
        pwrChipStation.setText(text);
        if (pwrChipSweep != null) pwrChipSweep.setText(text);
    }

    // ---- power favourites --------------------------------------------------
    // Pairing at power 1 beats 2 (2 sometimes grabs the neighbouring tag),
    // and sweeps want 5-10 - so the same few levels get flipped between all
    // day. Favourites make that one gesture: long-press any PWR chip to
    // cycle them, no dialog, no slider.
    /** power -> operator's name for it ("" = unnamed). Stored "1:pair,5:bin";
     *  first run is seeded with the old presets so the dialog is never
     *  empty, but once the operator touches them they're entirely theirs. */
    private java.util.TreeMap<Integer, String> favMap() {
        java.util.TreeMap<Integer, String> out = new java.util.TreeMap<>();
        if (!prefs.contains("fav_powers")) {
            for (int i = 0; i < PRESET_LEVELS.length; i++) {
                out.put(PRESET_LEVELS[i], PRESET_NAMES[i]);
            }
            return out;
        }
        for (String s : prefs.getString("fav_powers", "").split(",")) {
            String[] parts = s.split(":", 2);
            try {
                int v = Integer.parseInt(parts[0].trim());
                if (v >= 1 && v <= 30) {
                    out.put(v, parts.length > 1 ? parts[1].trim() : "");
                }
            } catch (Exception ignored) {
            }
        }
        return out;
    }

    private void saveFavMap(java.util.TreeMap<Integer, String> favs) {
        StringBuilder sb = new StringBuilder();
        for (java.util.Map.Entry<Integer, String> e : favs.entrySet()) {
            if (sb.length() > 0) sb.append(",");
            sb.append(e.getKey());
            if (!e.getValue().isEmpty()) sb.append(":").append(e.getValue());
        }
        prefs.edit().putString("fav_powers", sb.toString()).apply();
        updatePowerChips(prefs.getInt("power", 5));
    }

    private java.util.List<Integer> favPowers() {
        return new ArrayList<>(favMap().keySet());
    }

    private void wirePowerChip(Button chip) {
        chip.setOnClickListener(x -> showPowerDialog());
        chip.setOnLongClickListener(x -> {
            cycleFavPower();
            return true;
        });
    }

    /** Long-press on a PWR chip: jump to the next favourite level. */
    private void cycleFavPower() {
        java.util.List<Integer> favs = favPowers();
        if (favs.isEmpty()) {
            beep(SOUND_ERR);
            status.setText("No favourite power levels yet — tap the PWR "
                    + "chip and star the levels you use.");
            return;
        }
        int cur = prefs.getInt("power", 5);
        int next = favs.get(0);
        for (int v : favs) {
            if (v > cur) {
                next = v;
                break;
            }
        }
        beep(SOUND_OTHER);
        setPowerLevel(next);
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
        // (Its change listener is attached below, after the favourites row
        // exists — the star button's label follows the slider.)
        box.addView(seek);

        // ---- favourites, where the fixed presets used to sit ---------------
        // The operator's levels with the operator's names ("1 pair", "5
        // bin"), not ours. Tap = use it; hold = use / rename / remove. The
        // level currently set is highlighted like the active pair card.
        final LinearLayout favRow = new LinearLayout(this);
        final Button starBtn = smallBtn("");
        final Runnable[] rebuild = new Runnable[1];
        rebuild[0] = () -> {
            favRow.removeAllViews();
            java.util.TreeMap<Integer, String> favs = favMap();
            int now = prefs.getInt("power", 5);
            starBtn.setText(favs.containsKey(now)
                    ? "★ Unstar " + now : "☆ Star " + now);
            if (favs.isEmpty()) {
                TextView none = new TextView(this);
                none.setText("No favourites — pick a power, then star it.");
                none.setTextSize(12);
                none.setTextColor(C_MUTED);
                favRow.addView(none);
                return;
            }
            for (java.util.Map.Entry<Integer, String> e : favs.entrySet()) {
                final int p = e.getKey();
                final String name = e.getValue();
                Button chip = smallBtn(
                        p + (name.isEmpty() ? "" : " " + name));
                if (p == now) {
                    chip.setBackground(btnBg(Color.parseColor("#dbe9ff"),
                            C_BLUE, C_SOFT_DK, 8));
                    chip.setTextColor(C_BLUE);
                    chip.setTypeface(null, Typeface.BOLD);
                }
                chip.setOnClickListener(x -> {
                    seek.setProgress(p - 1);
                    setPowerLevel(p);
                    label.setText("RFID power: " + p);
                    rebuild[0].run();
                });
                chip.setOnLongClickListener(x -> {
                    favChipMenu(p, name, seek, label, rebuild[0]);
                    return true;
                });
                LinearLayout.LayoutParams cl = new LinearLayout.LayoutParams(
                        0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f);
                cl.rightMargin = dp(5);
                favRow.addView(chip, cl);
            }
        };
        rebuild[0].run();
        box.addView(favRow);

        starBtn.setOnClickListener(x -> {
            int now = seek.getProgress() + 1;
            java.util.TreeMap<Integer, String> favs = favMap();
            if (favs.containsKey(now)) favs.remove(now);
            else favs.put(now, "");
            saveFavMap(favs);
            rebuild[0].run();
        });
        seek.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            @Override
            public void onProgressChanged(SeekBar s, int p, boolean u) {
                label.setText("RFID power: " + (p + 1));
                starBtn.setText(favMap().containsKey(p + 1)
                        ? "★ Unstar " + (p + 1) : "☆ Star " + (p + 1));
            }

            @Override
            public void onStartTrackingTouch(SeekBar s) {
            }

            @Override
            public void onStopTrackingTouch(SeekBar s) {
                setPowerLevel(s.getProgress() + 1);
                rebuild[0].run();
            }
        });
        LinearLayout.LayoutParams stl = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT);
        stl.topMargin = dp(8);
        box.addView(starBtn, stl);

        TextView hint = new TextView(this);
        hint.setText("Tap a favourite to use it · hold it to rename or "
                + "remove.\nLong-press any PWR chip to cycle favourites "
                + "without opening this.");
        hint.setTextSize(11);
        hint.setTextColor(C_MUTED);
        hint.setPadding(0, dp(8), 0, 0);
        box.addView(hint);

        new AlertDialog.Builder(this)
                .setTitle("Scanner power")
                .setView(box)
                .setPositiveButton("Done", null)
                .show();
    }

    /** Hold on a favourite: use it, name it, or drop it. */
    private void favChipMenu(int power, String name, SeekBar seek,
                             TextView label, Runnable rebuild) {
        String shown = power + (name.isEmpty() ? "" : " " + name);
        String[] opts = {"Use power " + power, "Rename…",
                "Remove from favourites"};
        new AlertDialog.Builder(this)
                .setTitle("★ " + shown)
                .setItems(opts, (d, which) -> {
                    if (which == 0) {
                        seek.setProgress(power - 1);
                        setPowerLevel(power);
                        label.setText("RFID power: " + power);
                        rebuild.run();
                    } else if (which == 1) {
                        final EditText in = new EditText(this);
                        in.setText(name);
                        in.setHint("e.g. pair, bin, rack");
                        new AlertDialog.Builder(this)
                                .setTitle("Name for power " + power)
                                .setView(in)
                                .setPositiveButton("Save", (dd, ww) -> {
                                    java.util.TreeMap<Integer, String> favs =
                                            favMap();
                                    // ',' and ':' would corrupt the stored
                                    // CSV, so they can't be part of a name.
                                    favs.put(power, in.getText().toString()
                                            .replace(",", " ")
                                            .replace(":", " ")
                                            .trim());
                                    saveFavMap(favs);
                                    rebuild.run();
                                })
                                .setNegativeButton("Cancel", null)
                                .show();
                    } else {
                        java.util.TreeMap<Integer, String> favs = favMap();
                        favs.remove(power);
                        saveFavMap(favs);
                        rebuild.run();
                    }
                })
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
        if (step == STEP_VERIFY && scanning) {
            try {
                reader.stopInventory();
            } catch (Exception ignored) {
            }
            scanning = false;
        }
        step--;
        pairActive = null;
        if (step == STEP_CHECK) fetchReview();
        applyBatchUi();
    }

    private void stepNext() {
        if (!inBatch()) return;
        // On a side trip there is no verify step: it covers a few carried
        // boxes, never the whole shelf. NEXT hands back to the batch that
        // sent us instead.
        if (parentBatchId != 0 && step == STEP_PAIR) {
            int missing = 0;
            for (BItem b : bItems) {
                if (b.resolved && b.paired < b.labelsTotal) {
                    missing += b.labelsTotal - b.paired;
                }
            }
            final int left = missing;
            if (left > 0) {
                new AlertDialog.Builder(this)
                        .setTitle("Finish side trip?")
                        .setMessage(left + " label(s) here still have no tag "
                                + "paired.\n\nGo back to " + parentBinName
                                + " anyway?")
                        .setPositiveButton("Finish", (d, w) -> finishSideTrip())
                        .setNegativeButton("Stay", null)
                        .show();
            } else {
                finishSideTrip();
            }
            return;
        }
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
            // Undecided wrong-shelf boxes come first: a label printed
            // now names THIS bin, which forecloses the move.
            if (parentBatchId == 0 && !strayEntries().isEmpty()) {
                showStrayReview(true);
                return;
            }
            askPrintOrSkip();
        } else if (step == STEP_PAIR) {
            // Sweep the finished bin here rather than sending the operator
            // back to the desk to do it.
            step = STEP_VERIFY;
            startVerifyStep();
            applyBatchUi();
        } else {
            // VERIFY: the advancing button IS "SEND SWEEP" — sending shows
            // the results table, and confirming from there hands the bin to
            // the web terminal. One path, not a FINISH button that half the
            // time answered "go do it on the PC".
            sendVerifySweepAndReport();
        }
    }

    // ------------------------------------------------------------ verify ---
    private void startVerifyStep() {
        if (scanning) {
            try {
                reader.stopInventory();
            } catch (Exception ignored) {
            }
            scanning = false;
        }
        synchronized (tags) { tags.clear(); }
        pairActive = null;
        previewItem = null;
    }

    private void clearVerifySweep() {
        synchronized (tags) { tags.clear(); }
        beep(SOUND_OTHER);
        status.setText("Sweep cleared — pull the trigger to scan the bin "
                + "again.");
        refreshBatchList();
    }

    // Send the bin sweep to the server. The web terminal watching this
    // batch picks it up on its own and shows the verification there — the
    // reading and deciding happen on a screen big enough for it.
    private void sendVerifySweepAndReport() {
        if (scanning) {
            try {
                reader.stopInventory();
            } catch (Exception ignored) {
            }
            scanning = false;
        }
        final List<String> epcs = new ArrayList<>();
        synchronized (tags) { epcs.addAll(tags.keySet()); }
        if (epcs.isEmpty()) {
            beep(SOUND_ERR);
            status.setText("Nothing swept yet - pull the trigger and walk "
                    + "the bin first, then SEND SWEEP.");
            return;
        }
        status.setText("Sending " + epcs.size() + " tag(s)\u2026");
        new Thread(() -> {
            try {
                // The capture first: the web terminal watching this batch
                // notices it and jumps to its own verification screen, so
                // by the time the operator walks back the PC is ready.
                JSONObject body = new JSONObject()
                        .put("device", prefs.getString("device", "C72"))
                        .put("batch_id", batchId)
                        .put("note", "Bin " + batchBin + " verify sweep")
                        .put("epcs", new JSONArray(epcs));
                api("POST", "/api/epc-captures", body);
                // Then the same sweep against the bin, for the on-device
                // table: every product the bin knows about, with tags on
                // file / in this bin / actually heard. The batch's own
                // SKUs ride along — open-box twins and kept strays live
                // in this batch without being in the bin map, and their
                // tags deserve real counts, not "seen 0 of 0".
                JSONArray batchSkus = new JSONArray();
                for (BItem b : bItems) {
                    if (b.resolved && b.sku != null) batchSkus.put(b.sku);
                }
                JSONObject check = api("POST", "/api/bins/"
                        + URLEncoder.encode(batchBin, "UTF-8") + "/check",
                        new JSONObject()
                                .put("epcs", new JSONArray(epcs))
                                .put("skus", batchSkus));
                final JSONArray checkItems = check.optJSONArray("items");
                final int sweptCount = epcs.size();
                ui.post(() -> {
                    beep(SOUND_OK);
                    status.setText("Sweep sent \u2713 (" + sweptCount
                            + " tags) - the PC/iPad is showing it too.");
                    showVerifyReport(checkItems);
                });
            } catch (Exception e) {
                ui.post(() -> {
                    beep(SOUND_ERR);
                    status.setText("Send FAILED (" + e.getMessage()
                            + ") - tags kept; get Wi-Fi and press SEND "
                            + "SWEEP again.");
                });
            }
        }).start();
    }

    /** One line of the on-device verify table: a batch item, a bin-map
     *  product, or both merged by (case-insensitive) SKU. */
    private static class VRow {
        String sku, title, variant, imageUrl;
        Integer expected;
        int printed, paired, detected, tagsHere, tagsOnFile;
        // Boxes stickered before this batch — 0 printed / 0 paired on
        // this row is correct, the sweep just has to hear their tags.
        int taggedBefore;
        boolean noScan, inBatch;

        String name() {
            String n = title == null || title.isEmpty() ? "(unknown)"
                    : title;
            if (variant != null && !variant.isEmpty()) {
                n += " (" + variant + ")";
            }
            return n;
        }
    }

    /** A row passes when every printed label got a tag AND every tag this
     *  bin should hold answered the sweep \u2014 including tags from earlier
     *  sessions the batch itself never touched. "Won't RFID scan"
     *  products are expected silent, so only pairing is judged. */
    private boolean verifyRowOk(VRow r) {
        if (r.noScan) return r.paired >= r.printed;
        return r.paired >= r.printed
                && r.detected >= Math.max(r.paired, r.tagsHere);
    }

    /** The verify table: the WHOLE bin's story, not just this batch's \u2014
     *  a product tagged on an earlier side trip shows its tags and
     *  whether the sweep heard them. Worst rows first; every row shows
     *  its SKU and taps open a preview. */
    private void showVerifyReport(JSONArray checkItems) {
        java.util.HashMap<String, VRow> bySku = new java.util.HashMap<>();
        List<VRow> rows = new ArrayList<>();
        for (int i = 0; checkItems != null && i < checkItems.length(); i++) {
            JSONObject o = checkItems.optJSONObject(i);
            if (o == null || o.isNull("sku")) continue;
            VRow r = new VRow();
            r.sku = o.optString("sku");
            r.title = o.isNull("product_title") ? ""
                    : o.optString("product_title");
            r.variant = o.isNull("variant_title") ? null
                    : o.optString("variant_title");
            r.imageUrl = o.isNull("image_url") ? null
                    : o.optString("image_url");
            r.expected = o.isNull("expected_qty") ? null
                    : o.optInt("expected_qty");
            r.tagsOnFile = o.optInt("tags_on_file", 0);
            // Older servers don't send tags_here; the store-wide count is
            // the honest fallback.
            r.tagsHere = o.optInt("tags_here", r.tagsOnFile);
            r.detected = o.optInt("detected", 0);
            r.noScan = o.optBoolean("rfid_incompatible", false);
            bySku.put(r.sku.toUpperCase(java.util.Locale.ROOT), r);
            rows.add(r);
        }
        // Batch rows fold in on top: printed/paired counts, and any stray
        // worked here that the bin map doesn't list gets its own line.
        for (BItem b : bItems) {
            if (!b.resolved) continue;
            VRow r = b.sku == null ? null
                    : bySku.get(b.sku.toUpperCase(java.util.Locale.ROOT));
            if (r == null) {
                if (b.labelsTotal == 0 && b.paired == 0) continue;
                r = new VRow();
                r.sku = b.sku == null ? "\u2014" : b.sku;
                r.title = b.title;
                r.variant = b.variant;
                r.imageUrl = b.imageUrl;
                r.expected = b.expected;
                rows.add(r);
            }
            r.inBatch = true;
            r.printed = b.labelsTotal;
            r.paired = b.paired;
            r.taggedBefore = b.taggedBefore;
            r.noScan = r.noScan || b.noScan;
            if (r.imageUrl == null) r.imageUrl = b.imageUrl;
        }
        // Nothing printed, nothing paired, no tags to hear: there is
        // nothing to verify on that line \u2014 it's collect/check business.
        java.util.Iterator<VRow> itr = rows.iterator();
        while (itr.hasNext()) {
            VRow r = itr.next();
            if (r.printed == 0 && r.paired == 0 && r.tagsHere == 0
                    && r.detected == 0 && r.taggedBefore == 0) {
                itr.remove();
            }
        }
        int bad = 0;
        for (VRow r : rows) {
            if (!verifyRowOk(r)) bad++;
        }
        // Worst first: the rows needing eyes should not hide under a page
        // of green.
        java.util.Collections.sort(rows, (a, b2) -> {
            boolean oa = verifyRowOk(a);
            boolean ob = verifyRowOk(b2);
            return oa == ob ? 0 : (oa ? 1 : -1);
        });

        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(14), dp(8), dp(14), dp(4));
        GradientDrawable gapD = new GradientDrawable();
        gapD.setSize(0, dp(6));
        box.setShowDividers(LinearLayout.SHOW_DIVIDER_MIDDLE);
        box.setDividerDrawable(gapD);

        TextView head = new TextView(this);
        head.setText(bad == 0
                ? "Every product checks out \u2713"
                : bad + " product(s) need a look:");
        head.setTextSize(13);
        head.setTypeface(null, Typeface.BOLD);
        head.setTextColor(bad == 0 ? C_OK : C_OVER);
        box.addView(head);

        for (VRow r : rows) {
            final VRow fr = r;
            boolean ok = verifyRowOk(r);
            LinearLayout row = new LinearLayout(this);
            row.setGravity(Gravity.CENTER_VERTICAL);
            row.setBackground(rr(ok ? C_OK_BG : C_OVER_BG, 0, 8));
            row.setPadding(dp(8), dp(6), dp(8), dp(6));
            TextView mark = new TextView(this);
            mark.setText(r.noScan && ok ? "\u2298" : ok ? "\u2713" : "\u2717");
            mark.setTextSize(18);
            mark.setTypeface(null, Typeface.BOLD);
            mark.setTextColor(ok ? C_OK : C_OVER);
            mark.setPadding(0, 0, dp(10), 0);
            row.addView(mark);
            LinearLayout col = new LinearLayout(this);
            col.setOrientation(LinearLayout.VERTICAL);
            TextView nm = new TextView(this);
            nm.setText(r.name());
            nm.setTextSize(13);
            nm.setTypeface(null, Typeface.BOLD);
            nm.setTextColor(C_TEXT);
            nm.setMaxLines(2);
            col.addView(nm);
            TextView counts = new TextView(this);
            counts.setText("SKU " + r.sku + "  \u00b7  "
                    + (r.inBatch
                       ? "printed " + r.printed + "  \u00b7  tagged " + r.paired
                         + (r.taggedBefore > 0
                            ? "  \u00b7  \u2713" + r.taggedBefore + " already tagged"
                            : "")
                       : "not in this batch")
                    + "  \u00b7  "
                    + (r.noScan ? "won't scan on box \u2014 seen n/a"
                       : "seen " + r.detected + " of " + r.tagsHere));
            counts.setTextSize(12);
            counts.setTextColor(C_MUTED);
            col.addView(counts);
            row.addView(col, weight());
            row.setOnClickListener(vw -> showVerifyRowPreview(fr));
            box.addView(row);
        }
        if (rows.isEmpty()) {
            TextView none = new TextView(this);
            none.setText("Nothing here has labels or tags to verify.");
            none.setTextSize(12);
            none.setTextColor(C_MUTED);
            box.addView(none);
        }

        ScrollView sc = new ScrollView(this);
        sc.addView(box);
        new AlertDialog.Builder(this)
                .setTitle("Verify bin " + batchBin)
                .setView(sc)
                .setPositiveButton("CONFIRM - finish on the web",
                        (d, w) -> confirmVerifyHandoff())
                .setNegativeButton("SWEEP AGAIN", (d, w) -> {
                    clearVerifySweep();
                    status.setText("Sweep cleared - pull the trigger to "
                            + "sweep the bin again, then SEND SWEEP.");
                })
                .show();
    }

    /** Tap a verify row: the product card \u2014 image, names, SKU, expected
     *  stock, and the tag story in words. Read-only. */
    private void showVerifyRowPreview(VRow r) {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(16), dp(10), dp(16), dp(4));

        ImageView img = new ImageView(this);
        img.setScaleType(ImageView.ScaleType.FIT_CENTER);
        img.setBackgroundColor(C_BG);
        LinearLayout.LayoutParams il = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, dp(140));
        il.bottomMargin = dp(8);
        box.addView(img, il);
        loadImage(r.imageUrl, img);

        TextView meta = new TextView(this);
        meta.setTextSize(14);
        meta.setTextColor(C_TEXT);
        StringBuilder sb = new StringBuilder();
        sb.append("SKU: ").append(r.sku);
        if (r.expected != null) {
            sb.append("\nExpected on this shelf: ").append(r.expected);
        }
        sb.append("\nTags in the system: ").append(r.tagsOnFile)
          .append(" (").append(r.tagsHere).append(" in this bin)");
        if (r.inBatch) {
            sb.append("\nThis batch: printed ").append(r.printed)
              .append(", tagged ").append(r.paired);
            if (r.taggedBefore > 0) {
                sb.append("\n✓ ").append(r.taggedBefore)
                  .append(" box(es) were already tagged before this "
                          + "batch — 0 printed/0 tagged here is "
                          + "expected; the sweep just has to hear them.");
            }
        } else {
            sb.append("\nNot part of this batch \u2014 tagged in an earlier "
                    + "session.");
        }
        sb.append("\nSweep heard: ").append(
                r.noScan ? "n/a \u2014 flagged \"won't scan on box\""
                         : r.detected + " of " + r.tagsHere);
        meta.setText(sb.toString());
        box.addView(meta);

        ScrollView sc = new ScrollView(this);
        sc.addView(box);
        new AlertDialog.Builder(this)
                .setTitle(r.name())
                .setView(sc)
                .setPositiveButton("CLOSE", null)
                .show();
    }

    /** Confirm from the report: park the batch as awaiting-verify (the
     *  server refuses to CLOSE from a scanner on purpose - counts get
     *  checked on a full screen) and drop back to the batch list. */
    private void confirmVerifyHandoff() {
        new Thread(() -> {
            try {
                JSONObject body = new JSONObject().put("created_by",
                        prefs.getString("device", "C72"));
                api("POST", "/api/batches/" + batchId + "/complete", body);
                // A 2xx means an older server closed it outright.
                final String bin = batchBin;
                ui.post(() -> {
                    beep(SOUND_OK);
                    exitBatch(true);
                    status.setText("Bin " + bin + " done \u2713");
                });
            } catch (Exception e) {
                final String msg = e.getMessage() == null
                        ? "" : e.getMessage();
                final String bin = batchBin;
                if (msg.contains("web terminal")) {
                    // The expected answer: the batch is parked as
                    // awaiting-verify and the web side already jumped to
                    // its verification screen when the sweep landed.
                    ui.post(() -> {
                        beep(SOUND_OK);
                        Toast.makeText(this,
                                "Handed to the web terminal \u2713",
                                Toast.LENGTH_LONG).show();
                        exitBatch(true);
                        status.setText("Bin " + bin + " is waiting on the "
                                + "PC/iPad - check the counts there and "
                                + "hit Complete batch.");
                    });
                } else {
                    ui.post(() -> {
                        beep(SOUND_ERR);
                        status.setText("Could not finish: " + msg);
                    });
                }
            }
        }).start();
    }

    /** Print, or jump straight to pairing when the labels already exist
     *  (re-pairing a shelf shouldn't reprint 34 stickers). */
    private void askPrintOrSkip() {
        new AlertDialog.Builder(this)
                .setTitle("Labels")
                .setMessage("Print labels for this bin, or skip "
                        + "printing and go straight to pairing?")
                .setPositiveButton("Print labels",
                        (d, w) -> queueLabels())
                .setNeutralButton("Skip → pair", (d, w) -> skipPrint())
                .setNegativeButton("Cancel", null)
                .show();
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
                    // Re-point the focused/pairing references at the FRESH
                    // rows by id. Nulling them (or leaving them on the old
                    // objects) froze the preview card's count after a
                    // sweep-pair until the barcode was scanned again.
                    Integer prevId =
                            previewItem == null ? null : previewItem.id;
                    Integer activeId =
                            pairActive == null ? null : pairActive.id;
                    bItems.clear();
                    bItems.addAll(loaded);
                    previewItem =
                            prevId == null ? null : itemById(prevId);
                    pairActive =
                            activeId == null ? null : itemById(activeId);
                    refreshBatchList();
                    updateBatchCard();
                });
            } catch (Exception e) {
                ui.post(() -> status.setText(e.getMessage()));
            }
        }).start();
    }

    // The unreadable-label rescue: hold the trigger, sweep the boxes, and
    // every tag nobody owns yet goes onto the product you're pairing.
    // Arming is a separate tap so a normal trigger pull still reads ONE
    // tag — a sweep that fired by accident would grab a shelf's worth.
    private void armSweep() {
        if (pairActive == null) {
            beep(SOUND_ERR);
            status.setText("Scan the product's barcode first, then SWEEP.");
            return;
        }
        if (!readerReady) {
            beep(SOUND_ERR);
            status.setText("RFID reader not ready.");
            return;
        }
        sweepArmed = true;
        beep(SOUND_OTHER);
        status.setText("SWEEP ARMED — HOLD the trigger over "
                + pairActive.name() + "'s boxes, release to assign.");
    }

    private void startHeldSweep() {
        if (pairActive == null || !readerReady) return;
        synchronized (tags) { tags.clear(); }
        if (!reader.startInventoryTag()) {
            sweepArmed = false;
            status.setText("Could not start the sweep.");
            return;
        }
        scanning = true;
        sweepRunning = true;
        status.setText("Sweeping… 0 tag(s) — release the trigger to stop.");
    }

    private void stopHeldSweep() {
        sweepRunning = false;
        sweepArmed = false;
        try {
            reader.stopInventory();
        } catch (Exception ignored) {
        }
        scanning = false;
        final BItem target = pairActive;
        final List<String> swept = new ArrayList<>();
        synchronized (tags) { swept.addAll(tags.keySet()); }
        if (target == null) return;
        if (swept.isEmpty()) {
            beep(SOUND_ERR);
            status.setText("Swept nothing — hold the trigger longer, or "
                    + "raise PWR.");
            return;
        }
        status.setText("Checking " + swept.size() + " swept tag(s)…");
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
                final int already = swept.size() - orphans.size();
                ui.post(() -> {
                    if (orphans.isEmpty()) {
                        beep(SOUND_OTHER);
                        status.setText("All " + swept.size() + " tag(s) "
                                + "swept are already linked — nothing "
                                + "orphaned here.");
                        return;
                    }
                    // Everything unowned belongs to the active product.
                    status.setText("Assigning " + orphans.size()
                            + " unlinked tag(s) to " + target.name()
                            + (already > 0 ? "  (" + already + " already "
                              + "linked, skipped)" : "") + "…");
                    assignEpcs(orphans, target);
                });
            } catch (Exception e) {
                ui.post(() -> {
                    beep(SOUND_ERR);
                    status.setText(e.getMessage());
                });
            }
        }).start();
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

    /** Spinner veil while a network call runs. UI thread only. */
    private void showLoading(String msg) {
        loadingText.setText(msg);
        loadingOverlay.setVisibility(View.VISIBLE);
    }

    private void hideLoading() {
        loadingOverlay.setVisibility(View.GONE);
    }

    private void fetchReview() {
        status.setText("Checking the batch…");
        showLoading("Checking the batch…");
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
                    e.recordBinTags = o.optInt("record_bin_tags", 0);
                    loaded.add(e);
                }
                ui.post(() -> {
                    hideLoading();
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
                        // Boxes on the wrong shelf: walk them one by one
                        // (keep here vs side trip) before any label
                        // exists to be reprinted.
                        showStrayReview(false);
                    }
                });
            } catch (Exception e) {
                ui.post(() -> {
                    hideLoading();
                    status.setText("Check failed: " + e.getMessage());
                });
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

    /** Bin barcode scanned with no batch open: start one right here on
     *  the gun (batches used to start on the PC/iPad only). */
    private void askStartBatch(String bin) {
        beep(SOUND_OTHER);
        new AlertDialog.Builder(this)
                .setTitle("Start a batch on " + bin + "?")
                .setMessage("Batch-tag bin " + bin + ": its expected "
                        + "products load and you collect every box on the "
                        + "shelf.\n\nIf a batch is already open on " + bin
                        + " it resumes instead of doubling up.")
                .setPositiveButton("START", (d, w) -> startBatchOnBin(bin))
                .setNegativeButton("Cancel", (d, w) ->
                        btInput.requestFocus())
                .show();
    }

    private void startBatchOnBin(String bin) {
        status.setText("Setting up " + bin + "…");
        showLoading("Loading bin " + bin + "…");
        new Thread(() -> {
            try {
                // Resume before create: an open batch on this bin is the
                // same physical job, not a reason for a duplicate.
                JSONObject open = api("GET", "/api/batches?status=open",
                        null);
                JSONArray arr = open.optJSONArray("batches");
                int resumeId = -1;
                for (int i = 0; arr != null && i < arr.length(); i++) {
                    JSONObject b = arr.optJSONObject(i);
                    if (b == null) continue;
                    if (bin.equalsIgnoreCase(b.optString("bin_name"))
                            && b.isNull("parent_batch_id")) {
                        resumeId = b.optInt("id");
                        break;
                    }
                }
                if (resumeId > 0) {
                    final int rid = resumeId;
                    ui.post(() -> {
                        hideLoading();
                        Toast.makeText(this, "Resuming the open batch on "
                                + bin, Toast.LENGTH_SHORT).show();
                        enterBatch(rid);
                    });
                    return;
                }
                JSONObject body = new JSONObject().put("bin", bin)
                        .put("created_by", prefs.getString("device", "C72"));
                JSONObject resp = api("POST", "/api/batches", body);
                final int id = resp.optInt("id");
                ui.post(() -> {
                    hideLoading();
                    enterBatch(id);
                });
            } catch (Exception e) {
                ui.post(() -> {
                    hideLoading();
                    beep(SOUND_ERR);
                    status.setText("Couldn't start " + bin + ": "
                            + e.getMessage());
                });
            }
        }).start();
    }

    /** EXIT asks what kind of leaving this is: parked-to-resume (the old
     *  behaviour) or abandoned outright — which used to need the web
     *  terminal. Side trips keep their own finish flow. */
    private void confirmExitBatch() {
        if (parentBatchId != 0) {
            exitBatch(false);
            return;
        }
        int paired = 0;
        for (BItem b : bItems) paired += b.paired;
        final int n = paired;
        new AlertDialog.Builder(this)
                .setTitle("Leave bin " + batchBin + "?")
                .setMessage("LEAVE OPEN parks the batch to resume later — "
                        + "on this gun or the web terminal.\n\nABANDON "
                        + "closes it for good"
                        + (n > 0 ? " and releases its " + n
                           + " tag tie(s)" : "")
                        + ". Nothing in Shopify changes either way.")
                .setPositiveButton("LEAVE OPEN", (d, w) -> exitBatch(false))
                .setNeutralButton("ABANDON…", (d, w) ->
                        confirmAbandonBatch(n))
                .setNegativeButton("Stay", null)
                .show();
    }

    private void confirmAbandonBatch(int ties) {
        new AlertDialog.Builder(this)
                .setTitle("Abandon " + batchBin + "?")
                .setMessage("The batch closes without completing"
                        + (ties > 0 ? ", its " + ties + " tag tie(s) are "
                           + "released (printed labels become unlinked "
                           + "stickers)" : "")
                        + ", and the bin goes back on the to-do list. "
                        + "History records the abandon.\n\n"
                        + "This can't be un-done from the gun.")
                .setPositiveButton("ABANDON BATCH", (d, w) ->
                        abandonBatch())
                .setNegativeButton("Cancel", null)
                .show();
    }

    private void abandonBatch() {
        status.setText("Abandoning…");
        new Thread(() -> {
            try {
                api("POST", "/api/batches/" + batchId + "/abandon",
                        new JSONObject());
                final String bin = batchBin;
                ui.post(() -> {
                    beep(SOUND_OK);
                    exitBatch(true);
                    status.setText("Batch on " + bin + " abandoned — the "
                            + "bin is back on the to-do list.");
                });
            } catch (Exception e) {
                ui.post(() -> {
                    beep(SOUND_ERR);
                    status.setText("Abandon failed: " + e.getMessage());
                });
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
                        status.setText("No open batches — scan a BIN "
                                + "barcode (like D1-3) to start one right "
                                + "here.");
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
                    loadScanOrder();
                    loadPriorAsked();
                    strayMove.clear();
                    bItems.clear();
                    bItems.addAll(loaded);
                    step = "awaiting-verify".equals(st) ? STEP_VERIFY
                            : ("printing".equals(st) || "pairing".equals(st))
                              ? STEP_PAIR : STEP_COLLECT;
                    if (step == STEP_VERIFY) startVerifyStep();
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

    // Tell the server which step this device is on so the PC/iPad watching
    // the same batch can follow along (status alone can't say it — collect
    // and check are both "collecting").
    private void publishStep() {
        if (!inBatch()) return;
        final String name = step == STEP_COLLECT ? "collect"
                : step == STEP_CHECK ? "check"
                : step == STEP_VERIFY ? "verify" : "pair";
        final int id = batchId;
        new Thread(() -> {
            try {
                api("POST", "/api/batches/" + id + "/step",
                        new JSONObject().put("step", name));
            } catch (Exception ignored) {
                // Best-effort: a missed signal only costs the other screen
                // a manual tap.
            }
        }).start();
    }

    private void applyBatchUi() {
        boolean in = inBatch();
        if (in) publishStep();
        binChip.setText(in ? "Bin " + batchBin : "No batch");
        phaseChip.setText(in
                ? STEP_NAMES[step] + "  " + (step + 1) + "/"
                  + (STEP_LAST + 1) : "PICK");
        pickBtn.setVisibility(in ? View.GONE : View.VISIBLE);
        batchBtnRow.setVisibility(in ? View.VISIBLE : View.GONE);
        // The two right-hand buttons change job with the step.
        btnUndo.setText(step == STEP_VERIFY ? "CLEAR" : "UNDO");
        if (step != STEP_COLLECT) baselineArmed = false;
        // In VERIFY the advancing button IS the send, so the third slot
        // would only duplicate it — hide it and the row reads as one path.
        btnSweep.setVisibility(step == STEP_VERIFY ? View.GONE : View.VISIBLE);
        // "BASE-\nLINE": the word alone is one letter too wide for the
        // button, and the stray E on its own line read as a typo.
        btnSweep.setText(step == STEP_PAIR ? "SWEEP"
                : step == STEP_COLLECT
                  ? (baselineArmed ? "APPLY\nBASELINE" : "BASE-\nLINE")
                  : "UNPAIR");
        btnNext.setText(parentBatchId != 0 && step == STEP_PAIR
                ? "FINISH TRIP"
                : step == STEP_VERIFY ? "SEND SWEEP" : "NEXT →");
        if (in) {
            if (step == STEP_COLLECT) {
                status.setText("COLLECT: scan every box in this bin, then "
                        + "NEXT.");
            } else if (step == STEP_CHECK) {
                status.setText(checkEntries.isEmpty()
                        ? "CHECK: nothing flagged ✓ — NEXT queues labels."
                        : "CHECK: tap flagged items to review — NEXT "
                          + "queues labels.");
            } else if (step == STEP_PAIR) {
                status.setText("PAIR: scan a product barcode, TRIGGER each "
                        + "sticker; NEXT verifies the bin.");
            } else {
                status.setText("VERIFY: pull the trigger to sweep the whole "
                        + "bin, then SEND SWEEP — the results show here AND "
                        + "on the PC/iPad.");
            }
        } else {
            status.setText("Pick an open batch (started on the PC/iPad).");
            batchCard.setVisibility(View.GONE);
        }
        updateBatchCard();
        refreshBatchList();
        if (activeTab == TAB_BATCH) btInput.requestFocus();
    }

    /** The product the preview card shows: the pair target while pairing,
     *  else the most recently scanned item. Null at the Check step. */
    private BItem focusedItem() {
        BItem it = step == STEP_PAIR && pairActive != null
                ? pairActive : previewItem;
        return step == STEP_CHECK ? null : it;
    }

    private void updateBatchCard() {
        BItem it = focusedItem();
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

    // ------------------------------------------------ local scan ordering ---
    // Which item was scanned most recently: a plain counter that bumps on
    // every scan, kept ON THE GUN only (prefs, keyed to the batch) — the
    // server never hears about it. A resumed bin keeps its order; a
    // different bin starts fresh.
    private int scanSeq = 0;
    private final java.util.HashMap<Integer, Integer> scanOrder =
            new java.util.HashMap<>();

    private void noteScanned(int itemId) {
        scanOrder.put(itemId, ++scanSeq);
        try {
            JSONObject o = new JSONObject();
            for (java.util.Map.Entry<Integer, Integer> e
                    : scanOrder.entrySet()) {
                o.put(String.valueOf(e.getKey()), e.getValue());
            }
            prefs.edit().putString("scan_order_json", new JSONObject()
                    .put("batch", batchId)
                    .put("seq", scanSeq)
                    .put("order", o).toString()).apply();
        } catch (Exception ignored) {
        }
    }

    private void loadScanOrder() {
        scanOrder.clear();
        scanSeq = 0;
        try {
            JSONObject saved = new JSONObject(
                    prefs.getString("scan_order_json", "{}"));
            if (saved.optInt("batch", -1) != batchId) return;
            scanSeq = saved.optInt("seq", 0);
            JSONObject o = saved.optJSONObject("order");
            if (o == null) return;
            java.util.Iterator<String> keys = o.keys();
            while (keys.hasNext()) {
                String k = keys.next();
                scanOrder.put(Integer.parseInt(k), o.getInt(k));
            }
        } catch (Exception ignored) {
        }
    }

    private int scanSeqOf(BItem b) {
        Integer s = scanOrder.get(b.id);
        return s == null ? 0 : s;
    }

    // Which items already got the "some of these are already tagged"
    // question, kept ON THE GUN like the scan order — asking once per
    // product per batch is the whole point.
    private final java.util.HashSet<Integer> priorAsked =
            new java.util.HashSet<>();

    // Wrong-shelf review decisions for THIS batch: item id -> "move".
    // ("keep" resolves itself - the bin update erases the flag - and an
    // undecided item simply stays in the map's absence.)
    private final java.util.HashSet<Integer> strayMove =
            new java.util.HashSet<>();

    private void notePriorAsked(int itemId) {
        priorAsked.add(itemId);
        try {
            org.json.JSONArray ids = new org.json.JSONArray();
            for (Integer id : priorAsked) ids.put(id);
            prefs.edit().putString("prior_asked_json", new JSONObject()
                    .put("batch", batchId)
                    .put("ids", ids).toString()).apply();
        } catch (Exception ignored) {
        }
    }

    private void loadPriorAsked() {
        priorAsked.clear();
        strayMove.clear();
        try {
            JSONObject saved = new JSONObject(
                    prefs.getString("prior_asked_json", "{}"));
            if (saved.optInt("batch", -1) != batchId) return;
            org.json.JSONArray ids = saved.optJSONArray("ids");
            for (int i = 0; ids != null && i < ids.length(); i++) {
                priorAsked.add(ids.getInt(i));
            }
        } catch (Exception ignored) {
        }
    }

    /** First scan of a product that already has tags in the system (a side
     *  trip, an earlier session): one screen asks how many boxes here are
     *  already stickered, so those queue no second label. Asked once per
     *  product per batch, collect step only. */
    private void maybePriorTagAlert(BItem it, boolean offerUncount) {
        if (!inBatch() || step != STEP_COLLECT) return;
        if (it == null || !it.resolved || it.skipped) return;
        if (it.priorTags <= 0 || it.taggedBefore > 0) return;
        if (priorAsked.contains(it.id)) return;
        notePriorAsked(it.id);
        beep(SOUND_OTHER);
        showAlreadyTaggedDialog(it, offerUncount);
    }

    /** The whole already-tagged answer on ONE screen (design settled with
     *  Nick 2026-08-06): a −/+ stepper for the stickered-box count, a live
     *  consequence line, and — when a scan triggered this — a checkbox
     *  that un-counts the box in hand. Count 0 gets a heads-up first. */
    private void showAlreadyTaggedDialog(BItem it, boolean offerUncount) {
        final int n = it.priorTags > 0 ? it.priorTags : it.taggedBefore;
        final int[] count = {
                it.taggedBefore > 0 ? it.taggedBefore : Math.max(1, n)
        };

        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(18), dp(6), dp(18), dp(2));

        TextView msg = new TextView(this);
        msg.setTextSize(13);
        msg.setTextColor(C_TEXT);
        String home = it.binLocation == null || it.binLocation.isEmpty()
                ? "no bin on record" : it.binLocation;
        msg.setText(it.name() + " was RFID-tagged before this batch (side "
                + "trip or earlier session) — " + n + " tag(s) in the "
                + "system.\nRecorded shelf: " + home + " — go look, or "
                + "SWEEP to count its tags in range.\n\n"
                + "Stickered boxes must not get a second label. Count the "
                + "boxes on this shelf that already wear a sticker:");
        box.addView(msg);

        LinearLayout steprow = new LinearLayout(this);
        steprow.setGravity(Gravity.CENTER);
        steprow.setPadding(0, dp(10), 0, dp(4));
        Button minus = smallBtn("−");
        TextView num = new TextView(this);
        num.setTextSize(30);
        num.setTypeface(null, Typeface.BOLD);
        num.setTextColor(C_TEXT);
        num.setGravity(Gravity.CENTER);
        num.setMinWidth(dp(64));
        Button plus = smallBtn("+");
        steprow.addView(minus, new LinearLayout.LayoutParams(dp(56),
                LinearLayout.LayoutParams.WRAP_CONTENT));
        steprow.addView(num);
        steprow.addView(plus, new LinearLayout.LayoutParams(dp(56),
                LinearLayout.LayoutParams.WRAP_CONTENT));
        box.addView(steprow);

        TextView consequence = new TextView(this);
        consequence.setTextSize(12);
        consequence.setTextColor(C_BLUE);
        consequence.setGravity(Gravity.CENTER);
        consequence.setPadding(dp(8), dp(4), dp(8), dp(8));
        box.addView(consequence);

        // Hands-free answer: a short sweep, and the server says how many
        // of the tags in range belong to THIS product (bin_check with a
        // skus filter). Sets the stepper; the operator can still adjust.
        final Button sweepBtn =
                smallBtn("⚡ SWEEP — COUNT THIS PRODUCT'S TAGS");
        LinearLayout.LayoutParams swl = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT);
        swl.bottomMargin = dp(4);
        box.addView(sweepBtn, swl);
        final TextView sweepOut = new TextView(this);
        sweepOut.setTextSize(11);
        sweepOut.setTextColor(C_MUTED);
        sweepOut.setGravity(Gravity.CENTER);
        sweepOut.setPadding(dp(4), 0, dp(4), dp(8));
        box.addView(sweepOut);

        final android.widget.CheckBox held =
                new android.widget.CheckBox(this);
        held.setText("The box I just scanned is one of the stickered ones "
                + "— don't count its scan again");
        held.setTextSize(12);
        held.setTextColor(C_TEXT);
        held.setChecked(true);
        held.setVisibility(offerUncount ? View.VISIBLE : View.GONE);
        box.addView(held);

        Runnable refresh = () -> {
            num.setText(String.valueOf(count[0]));
            consequence.setText(count[0] > 0
                    ? "→ " + count[0] + " box(es) counted as already done "
                      + "· labels print only for the others"
                    : "→ no stickered boxes here — every box scanned "
                      + "gets a label");
            held.setEnabled(count[0] > 0);
            if (count[0] == 0) held.setChecked(false);
        };
        minus.setOnClickListener(v2 -> {
            if (count[0] > 0) count[0]--;
            refresh.run();
        });
        plus.setOnClickListener(v2 -> {
            if (count[0] < 500) count[0]++;
            refresh.run();
        });
        refresh.run();

        sweepBtn.setOnClickListener(v2 -> {
            if (it.sku == null) {
                sweepOut.setText("No SKU to match tags against.");
                return;
            }
            if (reader == null) {
                sweepOut.setText("RFID reader isn't ready.");
                return;
            }
            sweepBtn.setEnabled(false);
            sweepBtn.setText("Sweeping…");
            new Thread(() -> {
                final List<String> heard = new ArrayList<>();
                try {
                    synchronized (tags) { tags.clear(); }
                    reader.startInventoryTag();
                    Thread.sleep(2500);
                } catch (Exception ignored) {
                } finally {
                    try {
                        reader.stopInventory();
                    } catch (Exception ignored2) {
                    }
                }
                synchronized (tags) {
                    heard.addAll(tags.keySet());
                    tags.clear();
                }
                try {
                    JSONObject check = api("POST", "/api/bins/"
                            + URLEncoder.encode(batchBin, "UTF-8")
                            + "/check",
                            new JSONObject()
                                    .put("epcs", new JSONArray(heard))
                                    .put("skus", new org.json.JSONArray()
                                            .put(it.sku)));
                    int det = 0, onFile = 0;
                    JSONArray rows2 = check.optJSONArray("items");
                    for (int i = 0; rows2 != null && i < rows2.length();
                            i++) {
                        JSONObject o = rows2.optJSONObject(i);
                        if (o != null && it.sku.equalsIgnoreCase(
                                o.optString("sku"))) {
                            det = o.optInt("detected", 0);
                            onFile = o.optInt("tags_on_file", 0);
                            break;
                        }
                    }
                    final int fdet = det, fon = onFile;
                    final int ftotal = heard.size();
                    ui.post(() -> {
                        count[0] = Math.min(500, fdet);
                        refresh.run();
                        sweepOut.setText("Heard " + fdet + " tag(s) of "
                                + "this product · " + ftotal + " tag(s) "
                                + "in range · " + fon + " on file — "
                                + "count set to " + fdet + ".");
                        sweepBtn.setEnabled(true);
                        sweepBtn.setText("⚡ SWEEP AGAIN");
                    });
                } catch (Exception e) {
                    ui.post(() -> {
                        sweepOut.setText("Sweep check failed: "
                                + e.getMessage());
                        sweepBtn.setEnabled(true);
                        sweepBtn.setText(
                                "⚡ SWEEP — COUNT THIS PRODUCT'S TAGS");
                    });
                }
            }).start();
        });

        ScrollView sc = new ScrollView(this);
        sc.addView(box);
        new AlertDialog.Builder(this)
                .setTitle(n + " box(es) may already be stickered")
                .setView(sc)
                .setCancelable(false)
                .setPositiveButton("CONFIRM", (dg, w) -> {
                    if (count[0] == 0) {
                        confirmNoneStickered(it, offerUncount);
                    } else {
                        putTaggedBefore(it, count[0],
                                offerUncount && held.isChecked());
                    }
                })
                .setNegativeButton("CANCEL", (dg, w) -> {
                    // Re-asks on the next scan rather than silently
                    // printing doubles.
                    priorAsked.remove(it.id);
                    btInput.requestFocus();
                })
                .show();
    }

    /** Count 0 is a real answer with a quiet consequence — say it before
     *  saving, with a way back. */
    private void confirmNoneStickered(BItem it, boolean offerUncount) {
        new AlertDialog.Builder(this)
                .setTitle("No stickered boxes here")
                .setMessage(it.priorTags + " tag(s) stay in the system "
                        + "pointing at stock somewhere else. If you find a "
                        + "stickered box on this shelf later, use ALREADY "
                        + "TAGGED… in the item editor.")
                .setCancelable(false)
                .setPositiveButton("OK — SAVE", (dg, w) ->
                        putTaggedBefore(it, 0, false))
                .setNegativeButton("BACK", (dg, w) ->
                        showAlreadyTaggedDialog(it, offerUncount))
                .show();
    }

    private void putTaggedBefore(BItem it, int count, boolean uncountHeld) {
        status.setText("Saving already-tagged count…");
        new Thread(() -> {
            try {
                JSONObject body = new JSONObject()
                        .put("count", count)
                        .put("updated_by", prefs.getString("device", "C72"));
                JSONObject resp = api("PUT", "/api/batches/" + batchId
                        + "/items/" + it.id + "/tagged-before", body);
                final BItem fresh = BItem.from(resp.getJSONObject("item"));
                final String msg = resp.optString("message", "Saved.");
                ui.post(() -> {
                    replaceItem(fresh);
                    beep(SOUND_OK);
                    status.setText(msg);
                    updateBatchCard();
                    refreshBatchList();
                    // The dialog's checkbox already answered the "box in
                    // your hand" question — act on it, don't re-ask.
                    if (uncountHeld && fresh.qty > 0) {
                        postItemQty(fresh, fresh.qty - 1);
                    } else {
                        btInput.requestFocus();
                    }
                });
            } catch (Exception e) {
                ui.post(() -> {
                    beep(SOUND_ERR);
                    // Not marked asked anymore — the next scan re-asks
                    // rather than silently printing doubles.
                    priorAsked.remove(it.id);
                    status.setText("Couldn't save the already-tagged "
                            + "count: " + e.getMessage());
                    btInput.requestFocus();
                });
            }
        }).start();
    }

    private void postItemQty(BItem it, int qty) {
        new Thread(() -> {
            try {
                JSONObject resp = api("POST", "/api/batches/" + batchId
                        + "/items/" + it.id + "/qty",
                        new JSONObject().put("qty", qty));
                final BItem fresh = BItem.from(resp);
                ui.post(() -> {
                    replaceItem(fresh);
                    beep(SOUND_OK);
                    status.setText("Count fixed — " + fresh.qty
                            + " box(es) to label, " + fresh.taggedBefore
                            + " already stickered.");
                    updateBatchCard();
                    refreshBatchList();
                    btInput.requestFocus();
                });
            } catch (Exception e) {
                ui.post(() -> {
                    beep(SOUND_ERR);
                    status.setText("Couldn't fix the count: "
                            + e.getMessage());
                    btInput.requestFocus();
                });
            }
        }).start();
    }

    /** Swap an item in place by id, keeping the pair/preview pointers on
     *  the fresh object. */
    private void replaceItem(BItem fresh) {
        BItem existing = itemById(fresh.id);
        if (existing != null) {
            bItems.set(bItems.indexOf(existing), fresh);
            if (pairActive == existing) pairActive = fresh;
            if (previewItem == existing) previewItem = fresh;
        } else {
            bItems.add(0, fresh);
        }
        // An open editor keeps talking about the fresh row, not a ghost.
        if (editEntry != null && editEntry.item != null
                && editEntry.item.id == fresh.id) {
            editEntry.item = fresh;
            if (editScrim.getVisibility() == View.VISIBLE) {
                renderItemEditor();
            }
        }
    }

    private void refreshBatchList() {
        displayItems.clear();
        if (inBatch() && step == STEP_CHECK) {
            // Only flagged items — a clean bin shows an empty list.
            for (CheckEntry e : checkEntries) displayItems.add(e.item);
        } else if (inBatch() && step == STEP_VERIFY) {
            // Everything that got tagged, most recently scanned first.
            for (BItem b : bItems) {
                if (b.resolved && (b.paired > 0 || b.qty > 0)) {
                    displayItems.add(b);
                }
            }
            java.util.Collections.sort(displayItems,
                    (a, b2) -> scanSeqOf(b2) - scanSeqOf(a));
        } else {
            // A row holding only a sealed case has qty 0 but is very much
            // "touched", so count cases too.
            List<BItem> touched = new ArrayList<>();
            List<BItem> waiting = new ArrayList<>();
            for (BItem b : bItems) {
                if (b.qty > 0 || b.caseCount > 0 || b.paired > 0) {
                    touched.add(b);
                } else if (b.expected == null || b.expected > 0) {
                    // Pre-seeded rows with ZERO stock expected are noise —
                    // they only earn a row once a box is actually scanned.
                    waiting.add(b);
                }
            }
            // Scanned: most recent first (local counter; ties keep server
            // order). Not scanned yet: biggest expected stock first.
            java.util.Collections.sort(touched,
                    (a, b2) -> scanSeqOf(b2) - scanSeqOf(a));
            java.util.Collections.sort(waiting, (a, b2) ->
                    (b2.expected == null ? -1 : b2.expected)
                    - (a.expected == null ? -1 : a.expected));
            displayItems.addAll(touched);
            displayItems.addAll(waiting);
        }
        batchAdapter.notifyDataSetChanged();
    }

    // Tracker = two numbers only: scanned/expected while collecting,
    // paired/scanned while pairing.
    private String trackerText(BItem b) {
        if (step == STEP_VERIFY) {
            // Tags tied to this product; the detected-vs-paired comparison
            // happens on the web terminal after SEND SWEEP.
            return String.valueOf(b.paired);
        }
        // Pairing counts LABELS (loose boxes + sealed cases); collecting
        // counts UNITS, which is what Shopify's on-hand is measured in.
        // The denominator is how many labels were printed — a fixed target.
        // It used to be max(labels, paired), so over-pairing quietly moved
        // the goalposts and 5 tags on 4 labels still read "5/5".
        if (step == STEP_PAIR)
            return b.paired + "/" + b.labelsTotal;
        return b.expected != null ? b.unitsTotal + "/" + b.expected
                : String.valueOf(b.unitsTotal);
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
            // While pairing, the card says at a glance whether this product
            // is done (green) or has more tags on it than labels printed
            // (red). The selected product keeps its blue border on top of
            // that, so "which am I pairing into" and "is it finished" are
            // two separate signals instead of one fighting the other.
            int fill = Color.WHITE, stroke = C_LINE, trk = C_BLUE;
            if (inBatch() && step == STEP_PAIR && b.resolved
                    && b.labelsTotal > 0) {
                if (b.paired > b.labelsTotal) {
                    fill = C_OVER_BG;
                    stroke = C_OVER;
                    trk = C_OVER;
                } else if (b.paired == b.labelsTotal) {
                    fill = C_OK_BG;
                    stroke = C_OK;
                    trk = C_OK;
                }
            }
            // Selection is the BORDER only — an unfinished row stays white,
            // so fill colour means one thing and one thing alone: done or
            // over-paired.
            if (b == pairActive) stroke = C_BLUE;
            BItem focus = focusedItem();
            if (focus != null && b.id == focus.id) {
                // The just-scanned product wears a HEAVY accent border, so
                // it stands apart from the rest of the list at a glance.
                GradientDrawable g = rr(fill, C_BLUE, 10);
                g.setStroke(dp(3), C_BLUE);
                h.card.setBackground(g);
            } else {
                h.card.setBackground(rr(fill, stroke, 10));
            }
            h.tracker.setTextColor(trk);
            h.name.setText(b.name());
            h.sku.setText((b.sku != null ? "SKU: " + b.sku
                    : (b.resolved ? "no SKU" : "⚠ unknown barcode"))
                    + (b.taggedBefore > 0
                       ? "  ·  ✓" + b.taggedBefore + " already tagged"
                       : ""));
            String flags = checkFlagText.get(b.id);
            String bc = b.barcode != null ? b.barcode : b.scannedCode;
            if (b.skipped) {
                // Skipped rows read as a decision, in every step - the whole
                // point is that it stays visible rather than looking unscanned.
                h.card.setBackground(
                        rr(Color.parseColor("#f2f2f3"), C_LINE, 10));
                h.bc.setVisibility(View.VISIBLE);
                h.bc.setText("SKIPPED"
                        + (b.skipReason == null || b.skipReason.isEmpty()
                           ? "" : " — " + b.skipReason));
            } else if (inBatch() && step == STEP_CHECK && flags != null) {
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
                // A case code counts nothing until the operator says whether
                // the box is being opened — it changes units, labels and tags.
                if (resp.optBoolean("needs_case_decision")) {
                    final JSONObject box = resp.optJSONObject("case");
                    ui.post(() -> askCaseAction(code, box));
                    return;
                }
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
                    noteScanned(item.id);
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
                    maybePriorTagAlert(item, true);
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
        // Twins sharing a barcode (SS TH10 and its open-box listing, both
        // seeded from the same bin) both match the scan — but only one has
        // labels waiting for tags. First-match here used to hand the pair
        // target to a seeded row with nothing printed, so every label scan
        // "came up as OPEN BOX". Prefer work over emptiness:
        //   1. a match with unpaired labels,  2. any match with labels,
        //   3. any match at all.
        BItem match = null;
        for (int pass = 0; pass < 3 && match == null; pass++) {
            for (BItem b : bItems) {
                if (!b.resolved) continue;
                boolean hit = (b.barcode != null && b.barcode.equals(code))
                        || (b.sku != null && b.sku.equals(code));
                if (!hit) continue;
                if (pass == 0 && b.paired >= b.labelsTotal) continue;
                if (pass == 1 && b.labelsTotal == 0) continue;
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

    /** One strongest-tag read: what a single trigger pull returns. */
    private static class TagRead {
        String epc;          // the winner
        double rssi = -999;  // its best RSSI (dBm; closer to 0 = nearer)
        double runnerUp = -999;
        int distinct;        // how many different tags answered
    }

    /** Read for a short window and hand back the STRONGEST tag heard —
     *  so the sticker under the antenna wins over an already-applied tag
     *  sitting an inch away, instead of whichever answered first (the old
     *  single-shot behaviour, and the cause of "duplicate EPC" denials on
     *  dense shelves). Falls back to most-often-heard when the SDK gives
     *  no usable RSSI. Blocking — call off the UI thread. */
    private TagRead readStrongestTag(long windowMs) {
        final java.util.HashMap<String, Double> best =
                new java.util.HashMap<>();
        final java.util.HashMap<String, Integer> times =
                new java.util.HashMap<>();
        long until = System.currentTimeMillis() + windowMs;
        try {
            if (scanning) {
                reader.stopInventory();
                scanning = false;
            }
            while (System.currentTimeMillis() < until) {
                UHFTAGInfo info = null;
                try {
                    info = reader.inventorySingleTag();
                } catch (Exception ignored) {
                }
                if (info == null) continue;
                String epc = info.getEPC();
                if (epc == null || epc.isEmpty()) continue;
                double rssi = -999;
                try {
                    rssi = Double.parseDouble(info.getRssi());
                } catch (Exception ignored) {
                }
                Double prev = best.get(epc);
                if (prev == null || rssi > prev) best.put(epc, rssi);
                Integer n = times.get(epc);
                times.put(epc, n == null ? 1 : n + 1);
            }
        } catch (Exception ignored) {
        }
        if (best.isEmpty()) return null;
        boolean haveRssi = false;
        for (double v : best.values()) {
            if (v > -998) { haveRssi = true; break; }
        }
        TagRead out = new TagRead();
        out.distinct = best.size();
        for (String epc : best.keySet()) {
            double score = haveRssi ? best.get(epc) : times.get(epc);
            if (out.epc == null || score > out.rssi) {
                if (out.epc != null) out.runnerUp = out.rssi;
                out.rssi = score;
                out.epc = epc;
            } else if (score > out.runnerUp) {
                out.runnerUp = score;
            }
        }
        return out;
    }

    /** "picked the strongest of N" suffix, with a caution when a second
     *  tag was almost as loud — the pick could plausibly be wrong. */
    private static String pickNote(TagRead r) {
        if (r == null || r.distinct <= 1) return "";
        String s = " · strongest of " + r.distinct + " tags";
        if (r.runnerUp > -998 && r.rssi - r.runnerUp < 2.0) {
            s += " (another was NEARLY as close — check the pick)";
        }
        return s;
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
            final TagRead read = readStrongestTag(600);
            final String epc = read == null ? null : read.epc;
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
                            + " tags)" + pickNote(read));
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
        scanOrder.clear();
        scanSeq = 0;
        priorAsked.clear();
        strayMove.clear();
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

    /** versionName + versionCode of the APK actually installed. */
    private String appVersion() {
        try {
            android.content.pm.PackageInfo pi = getPackageManager()
                    .getPackageInfo(getPackageName(), 0);
            return pi.versionName + " (" + pi.versionCode + ")";
        } catch (Exception e) {
            return "?";
        }
    }

    // ---------------------------------------------------- split a scan pile --
    // Two 94216 boxes share a barcode but one is the open-box listing.
    // Reassign moves the WHOLE count; this divides it: a stepper per
    // candidate, and SPLIT stays locked until the counts add up to exactly
    // what was scanned - a box can't be lost or invented in the shuffle.
    private void openSplitDialog() {
        if (editEntry == null || editEntry.candidates.size() < 2) return;
        final BItem it = editEntry.item;
        final List<JSONObject> cands = editEntry.candidates;
        final int total = it.qty;
        final int[] counts = new int[cands.size()];
        for (int i = 0; i < cands.size(); i++) {
            if (cands.get(i).optString("shopify_variant_id")
                    .equals(entryVariantId(editEntry))) {
                counts[i] = total;   // start with everything where it is
            }
        }
        final TextView[] countViews = new TextView[cands.size()];

        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(14), dp(8), dp(14), dp(4));
        GradientDrawable gapD = new GradientDrawable();
        gapD.setSize(0, dp(8));
        box.setShowDividers(LinearLayout.SHOW_DIVIDER_MIDDLE);
        box.setDividerDrawable(gapD);

        final TextView tally = new TextView(this);
        tally.setTextSize(13);
        tally.setTypeface(null, Typeface.BOLD);

        final AlertDialog[] dlgRef = new AlertDialog[1];
        final Runnable refresh = () -> {
            int sum = 0;
            for (int i = 0; i < counts.length; i++) {
                sum += counts[i];
                countViews[i].setText(String.valueOf(counts[i]));
            }
            boolean ok = sum == total;
            tally.setText(ok
                    ? sum + " of " + total + " assigned ✓"
                    : sum + " of " + total + " assigned - every box needs "
                      + "a home");
            tally.setTextColor(ok ? C_OK : C_OVER);
            if (dlgRef[0] != null) {
                dlgRef[0].getButton(AlertDialog.BUTTON_POSITIVE)
                        .setEnabled(ok);
            }
        };

        for (int i = 0; i < cands.size(); i++) {
            final int idx = i;
            JSONObject c = cands.get(i);
            LinearLayout row = new LinearLayout(this);
            row.setGravity(Gravity.CENTER_VERTICAL);
            Button minus = smallBtn("−");
            minus.setOnClickListener(v -> {
                if (counts[idx] > 0) {
                    counts[idx]--;
                    refresh.run();
                }
            });
            row.addView(minus, new LinearLayout.LayoutParams(dp(42),
                    LinearLayout.LayoutParams.WRAP_CONTENT));
            TextView n = new TextView(this);
            n.setTextSize(17);
            n.setTypeface(null, Typeface.BOLD);
            n.setTextColor(C_BLUE);
            n.setGravity(Gravity.CENTER);
            countViews[i] = n;
            row.addView(n, new LinearLayout.LayoutParams(dp(40),
                    LinearLayout.LayoutParams.WRAP_CONTENT));
            Button plus = smallBtn("+");
            plus.setOnClickListener(v -> {
                counts[idx]++;
                refresh.run();
            });
            row.addView(plus, new LinearLayout.LayoutParams(dp(42),
                    LinearLayout.LayoutParams.WRAP_CONTENT));
            TextView nm = new TextView(this);
            nm.setText(c.optString("product_title", "?"));
            nm.setTextSize(12);
            nm.setTextColor(C_TEXT);
            nm.setMaxLines(2);
            nm.setPadding(dp(8), 0, 0, 0);
            row.addView(nm, weight());
            box.addView(row);
        }
        box.addView(tally);

        ScrollView sc = new ScrollView(this);
        sc.addView(box);
        AlertDialog dlg = new AlertDialog.Builder(this)
                .setTitle("Split " + total + " box(es)")
                .setView(sc)
                .setPositiveButton("SPLIT", (d, w) -> postSplit(cands, counts))
                .setNegativeButton("Cancel", null)
                .create();
        dlgRef[0] = dlg;
        dlg.show();
        refresh.run();
    }

    private void postSplit(List<JSONObject> cands, int[] counts) {
        if (editEntry == null) return;
        final int itemId = editEntry.item.id;
        editMsg.setText("Splitting…");
        new Thread(() -> {
            try {
                JSONArray parts = new JSONArray();
                for (int i = 0; i < cands.size(); i++) {
                    parts.put(new JSONObject()
                            .put("shopify_variant_id", cands.get(i)
                                    .optString("shopify_variant_id"))
                            .put("qty", counts[i]));
                }
                JSONObject resp = api("POST", "/api/batches/" + batchId
                        + "/items/" + itemId + "/split",
                        new JSONObject().put("parts", parts));
                final String msg = resp.optString("message", "Split ✓");
                ui.post(() -> {
                    beep(SOUND_OK);
                    closeItemEditor();
                    status.setText(msg);
                    reloadBatchAndReview();
                });
            } catch (Exception e) {
                ui.post(() -> {
                    beep(SOUND_ERR);
                    editMsg.setText("Split failed: " + e.getMessage());
                });
            }
        }).start();
    }

    // ------------------------------------------ unresolved barcode rescue ---
    // A box whose barcode is in no listing usually means the product's
    // Shopify barcode was left as its SKU or a placeholder. Rather than
    // walking back to the desk, look through THIS bin and hand the scanned
    // code to the product it really belongs to.
    private void loadOddCandidates(boolean recommendedOnly) {
        if (editEntry == null) return;
        final String scanned = editEntry.item.scannedCode == null
                ? "" : editEntry.item.scannedCode;
        editMsg.setText("Looking through " + batchBin + "…");
        new Thread(() -> {
            try {
                JSONObject resp = api("GET", "/api/bins/"
                        + URLEncoder.encode(batchBin, "UTF-8")
                        + "/odd-barcodes?scanned="
                        + URLEncoder.encode(scanned, "UTF-8"), null);
                final List<JSONObject> found = new ArrayList<>();
                if (recommendedOnly) {
                    JSONObject rec = resp.optJSONObject("recommended");
                    if (rec != null) found.add(rec);
                } else {
                    JSONArray arr = resp.optJSONArray("candidates");
                    for (int i = 0; arr != null && i < arr.length(); i++) {
                        found.add(arr.getJSONObject(i));
                    }
                }
                ui.post(() -> {
                    editMsg.setText("");
                    if (found.isEmpty()) {
                        beep(SOUND_ERR);
                        editMsg.setText(recommendedOnly
                                ? "Nothing in this bin stands out as the "
                                  + "likely match."
                                : "No product in this bin has an odd "
                                  + "barcode.");
                        return;
                    }
                    showOddPicker(found, scanned);
                });
            } catch (Exception e) {
                ui.post(() -> editMsg.setText("Lookup failed: "
                        + e.getMessage()));
            }
        }).start();
    }

    /** Pick which product in this bin the scanned code really belongs to.
     *  Proper cards — photo, title, SKU/barcode, and why it's a candidate —
     *  instead of the stock text list, which was a wall of unpadded lines
     *  on the gun's screen. Same card language as the rest of the app. */
    private void showOddPicker(List<JSONObject> found, String scanned) {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(14), dp(8), dp(14), dp(4));
        GradientDrawable gapD = new GradientDrawable();
        gapD.setSize(0, dp(8));
        box.setShowDividers(LinearLayout.SHOW_DIVIDER_MIDDLE);
        box.setDividerDrawable(gapD);

        TextView head = new TextView(this);
        head.setText("Scanned " + scanned
                + " — tap the product it really belongs to:");
        head.setTextSize(12);
        head.setTextColor(C_MUTED);
        box.addView(head);

        final AlertDialog[] dlg = new AlertDialog[1];
        for (JSONObject p : found) {
            LinearLayout row = new LinearLayout(this);
            row.setGravity(Gravity.CENTER_VERTICAL);
            row.setBackground(btnBg(Color.WHITE, C_LINE, C_PRESS, 10));
            row.setPadding(dp(10), dp(8), dp(10), dp(8));

            ImageView iv = new ImageView(this);
            iv.setScaleType(ImageView.ScaleType.FIT_CENTER);
            iv.setBackground(rr(C_BG, C_LINE, 8));
            LinearLayout.LayoutParams il =
                    new LinearLayout.LayoutParams(dp(52), dp(52));
            il.rightMargin = dp(10);
            row.addView(iv, il);
            loadImage(p.isNull("image_url") ? null
                    : p.optString("image_url"), iv);

            LinearLayout col = new LinearLayout(this);
            col.setOrientation(LinearLayout.VERTICAL);

            TextView nm = new TextView(this);
            String title = p.optString("product_title", "?");
            String vt = p.isNull("variant_title") ? ""
                    : p.optString("variant_title");
            nm.setText(vt.isEmpty() ? title : title + " (" + vt + ")");
            nm.setTextSize(14);
            nm.setTypeface(null, Typeface.BOLD);
            nm.setTextColor(C_TEXT);
            nm.setMaxLines(2);
            col.addView(nm);

            TextView meta = new TextView(this);
            String bc = p.isNull("barcode") ? "(none)"
                    : p.optString("barcode");
            meta.setText("SKU " + p.optString("sku", "?")
                    + "  ·  barcode " + bc);
            meta.setTextSize(12);
            meta.setTextColor(C_MUTED);
            col.addView(meta);

            // The server's one-liner on WHY this row is offered ("no
            // barcode set", "barcode is the SKU"…) — the deciding hint,
            // and the old list never showed it at all.
            String why = p.optString("reason", "");
            if (!why.isEmpty()) {
                TextView reason = new TextView(this);
                reason.setText(why);
                reason.setTextSize(11);
                reason.setTextColor(C_BLUE);
                col.addView(reason);
            }
            row.addView(col, weight());
            row.setOnClickListener(v -> {
                if (dlg[0] != null) dlg[0].dismiss();
                confirmGiveBarcode(p, scanned);
            });
            box.addView(row);
        }

        ScrollView sc = new ScrollView(this);
        sc.addView(box);
        dlg[0] = new AlertDialog.Builder(this)
                .setTitle("Which product is it?")
                .setView(sc)
                .setNegativeButton("Cancel", null)
                .show();
    }

    private void confirmGiveBarcode(JSONObject p, String scanned) {
        String title = p.optString("product_title", "?");
        String old = p.isNull("barcode") ? "(none)" : p.optString("barcode");
        new AlertDialog.Builder(this)
                .setTitle("Give this product the barcode?")
                .setMessage(title + "\n\nbarcode " + old + "  ->  " + scanned
                        + "\n\nThis changes the barcode in Shopify for real. "
                        + "Only do this if the box in your hand IS this "
                        + "product.")
                .setPositiveButton("Write it", (d, w) ->
                        giveBarcode(p, scanned))
                .setNegativeButton("Cancel", null)
                .show();
    }

    private void giveBarcode(JSONObject p, String scanned) {
        final int itemId = editEntry.item.id;
        final int qty = editEntry.item.qty;
        final String title = p.optString("product_title", "?");
        editMsg.setText("Writing to Shopify…");
        new Thread(() -> {
            try {
                JSONObject body = new JSONObject()
                        .put("target", p.isNull("sku")
                                ? p.optString("barcode") : p.optString("sku"))
                        .put("new_barcode", scanned)
                        .put("changed_by", prefs.getString("device", "C72"))
                        // The endpoint refuses to touch Shopify without
                        // this; the operator just answered the dialog above.
                        .put("confirmed", true);
                api("POST", "/api/barcode-overwrites", body);
                // The count was recorded against a row that isn't a real
                // product, so drop it and let the boxes be re-scanned.
                api("DELETE", "/api/batches/" + batchId + "/items/" + itemId,
                        null);
                ui.post(() -> {
                    closeItemEditor();
                    beep(SOUND_OK);
                    status.setText("Barcode written ✓ — now RE-SCAN those "
                            + qty + " box(es); they'll come up as " + title
                            + ".");
                    reloadBatchAndReview();
                });
            } catch (Exception e) {
                ui.post(() -> {
                    beep(SOUND_ERR);
                    editMsg.setText("Could not write it: " + e.getMessage());
                });
            }
        }).start();
    }

    // ------------------------------------------------- can't-scan / skip ---
    // Loose, bubble-wrapped, no readable barcode - you can see a box but you
    // can't say what it is. Marking it skipped keeps the row and the reason,
    // prints no label, and holds nothing up. It does NOT touch any count:
    // "I couldn't check this" is not "there are none of these", and writing
    // a quantity from a guess is how stock records get wrecked.
    private static final String[] SKIP_REASONS = {
        "No barcode on the box",
        "Wrapped — can't identify it",
        "Barcode damaged / unreadable",
        "Can't reach it",
        "Other",
    };

    private void askSkipReason() {
        if (editEntry == null) return;
        new AlertDialog.Builder(this)
                .setTitle("Why can't it be scanned?")
                .setItems(SKIP_REASONS, (d, which) ->
                        confirmSkip(SKIP_REASONS[which]))
                .setNegativeButton("Cancel", null)
                .show();
    }

    private void confirmSkip(String reason) {
        new AlertDialog.Builder(this)
                .setTitle("Skip this product?")
                .setMessage(reason + "\n\nIt stays on the list with that "
                        + "reason, gets no label, and won't hold up the "
                        + "batch.\n\nNothing is counted and no quantity "
                        + "changes — in Shopify or here. It comes back as a "
                        + "review task when the bin is closed.")
                .setPositiveButton("Skip it", (d, w) -> setItemSkip(true, reason))
                .setNegativeButton("Cancel", null)
                .show();
    }

    /** Flag/unflag the product "won't RFID scan" — the tag reads in hand
     *  but never on the box (ZWO Desicc, several Optolong lines). Sweeps
     *  and Verify stop expecting an answer; nothing else changes. */
    private void toggleNoScan() {
        if (editEntry == null || editEntry.item.sku == null) return;
        final BItem it = editEntry.item;
        final boolean want = !it.noScan;
        Runnable send = () -> {
            editMsg.setText(want ? "Flagging…" : "Removing the flag…");
            new Thread(() -> {
                try {
                    JSONObject body = new JSONObject()
                            .put("incompatible", want)
                            .put("changed_by",
                                    prefs.getString("device", "C72"));
                    api("PUT", "/api/products/"
                            + URLEncoder.encode(it.sku, "UTF-8")
                            + "/rfid-incompatible", body);
                    ui.post(() -> {
                        beep(SOUND_OK);
                        for (BItem b : bItems) {
                            if (b.sku != null
                                    && b.sku.equalsIgnoreCase(it.sku)) {
                                b.noScan = want;
                            }
                        }
                        it.noScan = want;
                        renderItemEditor();
                        editMsg.setText(want
                                ? "Flagged ⊘ — sweeps won't expect this "
                                  + "product to answer. Logged."
                                : "Flag removed ✓ — logged.");
                    });
                } catch (Exception e) {
                    ui.post(() -> editMsg.setText(e.getMessage()));
                }
            }).start();
        };
        if (want) {
            new AlertDialog.Builder(this)
                    .setTitle("Won't RFID scan?")
                    .setMessage(it.name() + "\n\nTag won't scan when on "
                            + "box. Labels still print and pairing still "
                            + "counts - but sweeps and Verify stop "
                            + "expecting its tags to answer.\n\nApplies to "
                            + "this product store-wide.")
                    .setPositiveButton("FLAG IT", (d, w) -> send.run())
                    .setNegativeButton("Cancel", null)
                    .show();
        } else {
            send.run();
        }
    }

    private void setItemSkip(boolean skipped, String reason) {
        if (editEntry == null) return;
        final int itemId = editEntry.item.id;
        editMsg.setText(skipped ? "Marking as skipped…" : "Putting it back…");
        new Thread(() -> {
            try {
                JSONObject body = new JSONObject().put("skipped", skipped);
                if (reason != null) body.put("reason", reason);
                JSONObject resp = api("POST", "/api/batches/" + batchId
                        + "/items/" + itemId + "/skip", body);
                final BItem updated = BItem.from(resp.getJSONObject("item"));
                final String msg = resp.optString("message", "Done.");
                ui.post(() -> {
                    BItem existing = itemById(updated.id);
                    if (existing != null) {
                        bItems.set(bItems.indexOf(existing), updated);
                    }
                    if (editEntry != null) editEntry.item = updated;
                    beep(SOUND_OK);
                    closeItemEditor();
                    status.setText(msg);
                    refreshBatchList();
                });
            } catch (Exception e) {
                ui.post(() -> {
                    beep(SOUND_ERR);
                    editMsg.setText("Could not do that: " + e.getMessage());
                });
            }
        }).start();
    }

    // ------------------------------------------------------ shelf baseline ---
    // A shelf that's PART tagged (Astronomik on D2-2): sweep it before
    // collecting, and every tag read marks its product as already done —
    // the batch becomes exactly the untagged remainder. Products with tags
    // on file that the sweep missed get flagged at CHECK instead of being
    // blindly re-tagged, because a weak read would put a second tag on a
    // box that already wears one.
    private boolean baselineArmed = false;

    private void baselineButton() {
        if (!baselineArmed) {
            if (scanning) toggleScan();
            synchronized (tags) { tags.clear(); }
            baselineArmed = true;
            btnSweep.setText("APPLY\nBASELINE");
            beep(SOUND_OTHER);
            status.setText("BASELINE: hold the trigger and sweep the whole "
                    + "shelf. Tags already on boxes here count as done. "
                    + "Then press APPLY BASELINE.");
        } else {
            applyBaselineSweep();
        }
    }

    private void applyBaselineSweep() {
        baselineArmed = false;
        btnSweep.setText("BASE-\nLINE");
        if (scanning) {
            try {
                reader.stopInventory();
            } catch (Exception ignored) {
            }
            scanning = false;
        }
        final List<String> epcs = new ArrayList<>();
        synchronized (tags) {
            epcs.addAll(tags.keySet());
            tags.clear();
        }
        if (epcs.isEmpty()) {
            beep(SOUND_ERR);
            status.setText("Nothing swept — press BASELINE again and hold "
                    + "the trigger over the shelf first.");
            return;
        }
        status.setText("Matching " + epcs.size() + " tag(s)…");
        new Thread(() -> {
            try {
                JSONObject body = new JSONObject()
                        .put("epcs", new JSONArray(epcs));
                JSONObject resp = api("POST",
                        "/api/batches/" + batchId + "/baseline", body);
                final String msg = resp.optString("message",
                        "Baseline applied.");
                ui.post(() -> {
                    beep(SOUND_OK);
                    new AlertDialog.Builder(this)
                            .setTitle("Shelf baseline")
                            .setMessage(msg)
                            .setPositiveButton("OK", null)
                            .show();
                    status.setText("Baseline ✓ — now scan only the untagged "
                            + "boxes.");
                    reloadBatchOnly();
                });
            } catch (Exception e) {
                ui.post(() -> {
                    beep(SOUND_ERR);
                    status.setText("Baseline failed: " + e.getMessage());
                });
            }
        }).start();
    }

    // ---------------------------------------------------------- side trip ---
    // Strays found in the bin being worked that belong on another shelf.
    // Caught at CHECK, before any label exists, so carrying them home costs
    // nothing: they move into a small batch for THAT bin, whose labels - and
    // therefore whose tags - name the right shelf. Finish, and the original
    // batch is exactly where it was left.
    private int parentBatchId = 0;
    private String parentBinName = null;

    // ------------------------------------------------------- context help ---
    private void helpDialog(String title, String body) {
        new AlertDialog.Builder(this)
                .setTitle(title)
                .setMessage(body)
                .setPositiveButton("GOT IT", null)
                .show();
    }

    /** The header "?": explains whatever screen — and batch step — is up. */
    private void showHelp() {
        if (activeTab == TAB_BATCH) {
            if (!inBatch()) {
                helpDialog("Batch tagging",
                        "Tag one bin at a time.\n\n"
                        + "• Type a bin name (or scan its bin barcode) and "
                        + "START, or RESUME an open batch from the list.\n"
                        + "• The flow is COLLECT → CHECK → PAIR → VERIFY; "
                        + "the NEXT button always advances.\n"
                        + "• Tap the bin name at the top any time to flag "
                        + "the bin \"ask first\" on the work list.");
            } else if (step == STEP_COLLECT) {
                helpDialog("1 · COLLECT",
                        "Scan the barcode of EVERY box in this bin — one "
                        + "scan per box, so three of the same product means "
                        + "three scans.\n\n"
                        + "• Tap an item to fix its count, bin, or details."
                        + "\n• Can't scan a box? Tap it and use CAN'T SCAN "
                        + "— SKIP; it stays visible and no count is "
                        + "invented.\n"
                        + "• BASE-LINE first on a part-tagged shelf: sweep "
                        + "the whole shelf and boxes already wearing tags "
                        + "count as done.\n"
                        + "• NEXT when every box is scanned.");
            } else if (step == STEP_CHECK) {
                helpDialog("2 · CHECK",
                        "The system compares your scans against Shopify "
                        + "and flags anything needing a decision: wrong "
                        + "shelf, count mismatch, several listings on one "
                        + "barcode, unknown barcodes, products expected "
                        + "here but never seen.\n\n"
                        + "• Tap a flagged item to review it — arrows pick "
                        + "between listings, TAKE IT TO <bin> starts a "
                        + "side trip for strays.\n"
                        + "• Wrong-shelf boxes get their own review: each "
                        + "one is MOVE (side trip) or KEEP HERE (the "
                        + "recorded bin becomes this shelf).\n"
                        + "• Nothing here blocks you; flags are warnings.\n"
                        + "• NEXT queues the labels for printing.");
            } else if (step == STEP_PAIR) {
                helpDialog("3 · PAIR",
                        "Stick the printed labels on their boxes and tie "
                        + "each label to its product:\n\n"
                        + "• Scan the product's BARCODE — it becomes "
                        + "active.\n"
                        + "• Pull the TRIGGER close to ONE sticker. The "
                        + "reader listens briefly and picks the strongest "
                        + "tag, so a neighbour's tag doesn't steal the "
                        + "pair.\n"
                        + "• Green = every label paired; red = more tags "
                        + "than labels. UNDO releases the last tag.\n"
                        + "• Low power (1–2) pairs most precisely.\n"
                        + "• NEXT moves to the bin sweep.");
            } else {
                helpDialog("4 · VERIFY",
                        "Prove the shelf: hold the trigger and sweep the "
                        + "whole bin, then SEND SWEEP.\n\n"
                        + "• The table shows printed vs tagged vs heard "
                        + "for every product — ⊘ rows are \"won't RFID "
                        + "scan\" products, which never answer and don't "
                        + "count against you.\n"
                        + "• CONFIRM hands the bin to the PC/iPad for the "
                        + "final Complete; SWEEP AGAIN clears and retries."
                        + "\n• Raise power (10+) for sweeps — distance "
                        + "matters here, precision doesn't.");
            }
        } else if (activeTab == TAB_STATION) {
            helpDialog("Scan Station",
                    "One-off tagging at the desk (Astronomik serials and "
                    + "quick singles):\n\n"
                    + "• Scan a barcode (or type a SKU) — the product "
                    + "shows with its tag count.\n"
                    + "• Pull the trigger near ONE sticker to link it. "
                    + "The strongest tag wins, and UNDO unlinks the last."
                    + "\n• Scan a BIN barcode (like D1-3) while a product "
                    + "is up to move the product there — RFID records and "
                    + "Shopify both.\n"
                    + "• ⊘ means the product is flagged \"won't RFID "
                    + "scan\": pair the sticker BEFORE applying it.");
        } else if (activeTab == TAB_SWEEP) {
            helpDialog("Sweep",
                    "Free-scan any shelf: hold the trigger and walk. "
                    + "Every unique tag is collected with a read count.\n\n"
                    + "• SEND uploads the sweep; the web terminal's "
                    + "Verify step and shelf tools can pull it.\n"
                    + "• CLEAR starts over. Higher power reads farther.");
        } else if (activeTab == TAB_FIND) {
            helpDialog("Find Bin",
                    "Where does this live? Scan any product barcode and "
                    + "the screen shows its product, bin and details — "
                    + "for putting strays back where they belong.");
        } else {
            helpDialog("Locate",
                    "Hunt a product's RFID tags by signal strength:\n\n"
                    + "• Scan or type a barcode/SKU — its tags on file "
                    + "load, with the recorded bin as a starting point.\n"
                    + "• TRIGGER starts/stops the hunt. The meter and the "
                    + "beeps rise as you close in (strongest tag wins).\n"
                    + "• Signal pegged? Drop the power: FAR hears the "
                    + "aisle, NEAR a bay or two, TOUCH only arm's reach.\n"
                    + "• FOUND IT? reads at power 1 with the antenna "
                    + "touching the sticker — a confirmed find drops that "
                    + "tag from the hunt so you can chase the next box.\n"
                    + "• TARGET… narrows to one tag, un-finds one, or "
                    + "resets the found marks.");
        }
    }

    /** The item editor "?": what every control in this window does. */
    private void showEditorHelp() {
        helpDialog("Item editor",
                "Everything about ONE product in this batch:\n\n"
                + "• ◀ ▶ flip between listings sharing this barcode "
                + "(open-box twins) — USE THIS LISTING reassigns.\n"
                + "• − / + fix the box count; the number after / is what "
                + "Shopify expects.\n"
                + "• BIN changes the product's shelf in Shopify. The "
                + "wrong-shelf row offers TAKE IT TO <bin> (side trip), "
                + "Belongs elsewhere (drop), Move here, or Ignore.\n"
                + "• CAN'T SCAN — SKIP keeps the row without inventing a "
                + "count.\n"
                + "• WON'T RFID SCAN flags the PRODUCT store-wide: label "
                + "prints, pairing counts, sweeps stop expecting it to "
                + "answer.\n"
                + "• Label format changes what prints on the label's two "
                + "lines.\n"
                + "• Unknown barcode? The FIND buttons list this bin's "
                + "products with odd barcodes so you can give one the "
                + "scanned code (writes to Shopify after a confirm).");
    }

    /** Tap on the bin name: flag (or unflag) this bin as "ask first" on
     *  the web work list. A note says WHY it needs a second opinion. */
    private void flagBinDialog() {
        if (batchBin == null || batchBin.isEmpty()) return;
        final EditText in = new EditText(this);
        in.setHint("Why? e.g. mixed consignment stock (optional)");
        in.setTextSize(13);
        int pad = dp(14);
        in.setPadding(pad, pad, pad, pad);
        new AlertDialog.Builder(this)
                .setTitle("Flag bin " + batchBin + "?")
                .setMessage("\"Ask first\": marks this bin on the work list "
                        + "as needing a word with someone who knows the "
                        + "inventory before it's scanned. Nothing is "
                        + "blocked or hidden.")
                .setView(in)
                .setPositiveButton("FLAG IT", (d, w) ->
                        postBinFlag(true, in.getText().toString().trim()))
                .setNeutralButton("REMOVE FLAG", (d, w) ->
                        postBinFlag(false, null))
                .setNegativeButton("Cancel", null)
                .show();
    }

    private void postBinFlag(boolean flagged, String note) {
        final String bin = batchBin;
        new Thread(() -> {
            try {
                JSONObject body = new JSONObject()
                        .put("flagged", flagged)
                        .put("flagged_by", prefs.getString("device", "C72"));
                if (note != null && !note.isEmpty()) body.put("note", note);
                api("PUT", "/api/bins/"
                        + URLEncoder.encode(bin, "UTF-8") + "/flagged", body);
                ui.post(() -> {
                    beep(SOUND_OK);
                    status.setText(flagged
                            ? "Bin " + bin + " flagged ⚑ — it shows \"ask "
                              + "first\" on the work list."
                            : "Flag removed from " + bin + ".");
                });
            } catch (Exception e) {
                ui.post(() -> {
                    beep(SOUND_ERR);
                    status.setText("Flag failed: " + e.getMessage());
                });
            }
        }).start();
    }

    /** First bin out of a possibly-split value: "G2-1 & B17" -> "G2-1". */
    private static String firstBin(String bins) {
        if (bins == null) return null;
        String first = bins.split("[&,]")[0].trim();
        return first.isEmpty()
                || "No bin assigned".equalsIgnoreCase(first) ? null : first;
    }

    /** "TAKE IT TO <bin>" from a wrong-bin item's editor: same server-side
     *  trip as the Check step's stray offer, but reachable per item — and
     *  from inside a side trip, which the automatic offer never is. */
    private void tripFromItem() {
        if (editEntry == null) return;
        final String bin = firstBin(editEntry.item.binLocation);
        if (bin == null) return;
        String name = editEntry.item.name();
        new AlertDialog.Builder(this)
                .setTitle("Take it to " + bin + "?")
                .setMessage(name + " leaves this batch and becomes a short "
                        + "side trip for " + bin + ": its labels print with "
                        + bin + " on them, you pair them there, then you're "
                        + "back here.\n\nAnything else in this batch that "
                        + "belongs in " + bin + " comes along too.")
                .setPositiveButton("Start the trip", (d, w) -> {
                    closeItemEditor();
                    startSideTrip(bin);
                })
                .setNegativeButton("Cancel", null)
                .show();
    }

    /** The wrong-shelf strays of this batch: resolved, counted, and still
     *  movable (nothing paired). Each needs a keep-or-move decision
     *  before labels print with THIS bin's name on them. */
    private List<CheckEntry> strayEntries() {
        List<CheckEntry> out = new ArrayList<>();
        for (CheckEntry e : checkEntries) {
            if (!e.flags.contains("wrong-bin")) continue;
            if (!e.item.resolved || e.item.paired > 0) continue;
            if (e.item.qty <= 0 && e.item.caseCount <= 0) continue;
            out.add(e);
        }
        return out;
    }

    /** Wrong-shelf review (design per Nick 2026-08-06): every stray with
     *  its product card, tapped one by one — MOVE (side trip) or KEEP
     *  (the recorded bin becomes this shelf). Replaces the old bulk
     *  "N boxes belong in X — take them?" offer that named no products. */
    private void showStrayReview(boolean fromNext) {
        List<CheckEntry> strays = strayEntries();
        if (strays.isEmpty()) return;
        if (parentBatchId != 0) return;   // trips don't nest from here

        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(14), dp(8), dp(14), dp(4));
        GradientDrawable gapD = new GradientDrawable();
        gapD.setSize(0, dp(6));
        box.setShowDividers(LinearLayout.SHOW_DIVIDER_MIDDLE);
        box.setDividerDrawable(gapD);

        TextView head = new TextView(this);
        head.setText(fromNext
                ? "Decide these before labels print — a label printed "
                  + "here names THIS bin:"
                : "On the wrong shelf — tap each one to decide:");
        head.setTextSize(12);
        head.setTextColor(C_MUTED);
        box.addView(head);

        final AlertDialog[] dlg = new AlertDialog[1];
        for (CheckEntry e : strays) {
            final CheckEntry fe = e;
            String home = firstBin(e.item.binLocation);
            boolean moving = strayMove.contains(e.item.id);

            LinearLayout row = new LinearLayout(this);
            row.setGravity(Gravity.CENTER_VERTICAL);
            row.setBackground(rr(moving ? C_OK_BG : Color.WHITE,
                    C_LINE, 8));
            row.setPadding(dp(8), dp(6), dp(8), dp(6));
            ImageView iv = new ImageView(this);
            iv.setScaleType(ImageView.ScaleType.CENTER_CROP);
            iv.setBackgroundColor(C_BG);
            LinearLayout.LayoutParams il =
                    new LinearLayout.LayoutParams(dp(46), dp(46));
            il.rightMargin = dp(8);
            row.addView(iv, il);
            loadImage(e.item.imageUrl, iv);
            LinearLayout col = new LinearLayout(this);
            col.setOrientation(LinearLayout.VERTICAL);
            TextView nm = new TextView(this);
            nm.setText(e.item.name());
            nm.setTextSize(13);
            nm.setTypeface(null, Typeface.BOLD);
            nm.setTextColor(C_TEXT);
            nm.setMaxLines(2);
            col.addView(nm);
            TextView sub = new TextView(this);
            sub.setText("SKU " + (e.item.sku == null ? "—" : e.item.sku)
                    + " · " + e.item.unitsTotal + " box(es) · here "
                    + batchBin + " → home " + home
                    + (e.recordBinTags > 0
                       ? "\n⚠ " + e.recordBinTags + " tagged box(es) "
                         + "already recorded at " + home
                       : ""));
            sub.setTextSize(11);
            sub.setTextColor(C_MUTED);
            col.addView(sub);
            row.addView(col, weight());
            TextView state = new TextView(this);
            state.setText(moving ? "MOVING ✓" : "DECIDE ▸");
            state.setTextSize(11);
            state.setTypeface(null, Typeface.BOLD);
            state.setTextColor(moving ? C_OK : C_BLUE);
            row.addView(state);
            row.setOnClickListener(vw -> {
                if (dlg[0] != null) dlg[0].dismiss();
                decideStray(fe);
            });
            box.addView(row);
        }

        ScrollView sc = new ScrollView(this);
        sc.addView(box);
        int undecided = 0;
        for (CheckEntry e : strays) {
            if (!strayMove.contains(e.item.id)) undecided++;
        }
        AlertDialog.Builder b = new AlertDialog.Builder(this)
                .setTitle(strays.size() + " box(es) on the wrong shelf")
                .setView(sc)
                .setNegativeButton(fromNext
                                ? "NOT NOW — LABELS PRINT HERE" : "LATER",
                        fromNext ? (dg, w) -> askPrintOrSkip() : null);
        if (undecided == 0) {
            String dest = firstBin(strays.get(0).item.binLocation);
            b.setPositiveButton("START TRIP TO " + dest,
                    (dg, w) -> startSideTrip(dest));
        }
        dlg[0] = b.show();
    }

    /** One stray, one screen: the product, both bins, the recorded-stock
     *  warning when its home shelf provably holds tagged boxes, and two
     *  spelled-out choices. */
    private void decideStray(CheckEntry e) {
        final String home = firstBin(e.item.binLocation);
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(18), dp(6), dp(18), dp(2));

        ImageView img = new ImageView(this);
        img.setScaleType(ImageView.ScaleType.FIT_CENTER);
        img.setBackgroundColor(C_BG);
        LinearLayout.LayoutParams il = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, dp(110));
        il.bottomMargin = dp(8);
        box.addView(img, il);
        loadImage(e.item.imageUrl, img);

        TextView meta = new TextView(this);
        meta.setTextSize(13);
        meta.setTextColor(C_TEXT);
        meta.setText("SKU: " + (e.item.sku == null ? "—" : e.item.sku)
                + "\nBoxes here: " + e.item.unitsTotal
                + "\nThis shelf: " + batchBin
                + "   ·   On record: " + home
                + (e.recordBinTags > 0
                   ? "\n\n⚠ " + e.recordBinTags + " tagged box(es) are "
                     + "already recorded at " + home + ". Keeping this "
                     + "one HERE moves the product's recorded bin — "
                     + "those boxes' records come along too, even though "
                     + "they sit at " + home + "."
                   : ""));
        box.addView(meta);

        Button move = smallBtn("MOVE IT TO " + home + " — side trip");
        move.setOnClickListener(vw -> {
            strayMove.add(e.item.id);
            ((AlertDialog) move.getTag()).dismiss();
            showStrayReview(false);
        });
        LinearLayout.LayoutParams bl = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT);
        bl.topMargin = dp(10);
        box.addView(move, bl);
        TextView moveHint = new TextView(this);
        moveHint.setText("Labels print with " + home + " on them; you "
                + "carry the box(es) there and pair them, then you're "
                + "back here.");
        moveHint.setTextSize(11);
        moveHint.setTextColor(C_MUTED);
        box.addView(moveHint);

        Button keep = smallBtn("KEEP IT HERE — bin becomes " + batchBin);
        LinearLayout.LayoutParams kl = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT);
        kl.topMargin = dp(8);
        box.addView(keep, kl);
        TextView keepHint = new TextView(this);
        keepHint.setText("Updates the recorded bin to " + batchBin
                + " (RFID system AND Shopify) and its labels print here.");
        keepHint.setTextSize(11);
        keepHint.setTextColor(C_MUTED);
        box.addView(keepHint);

        ScrollView sc = new ScrollView(this);
        sc.addView(box);
        AlertDialog d = new AlertDialog.Builder(this)
                .setTitle(e.item.name())
                .setView(sc)
                .setNegativeButton("LATER", (dg, w) ->
                        showStrayReview(false))
                .show();
        move.setTag(d);
        keep.setOnClickListener(vw -> {
            d.dismiss();
            postBinKeep(e);
        });
    }

    /** KEEP: the recorded bin becomes this shelf, via the same audited
     *  bin-update the Scan Station uses. The wrong-bin flag then clears
     *  itself on the re-check. */
    private void postBinKeep(CheckEntry e) {
        final String target = e.item.sku != null ? e.item.sku
                : e.item.barcode;
        if (target == null) {
            status.setText("No SKU or barcode to update the bin with.");
            return;
        }
        status.setText("Setting bin to " + batchBin + "…");
        new Thread(() -> {
            try {
                JSONObject body = new JSONObject()
                        .put("target", target)
                        .put("bin", batchBin)
                        .put("changed_by", prefs.getString("device", "C72"));
                api("POST", "/api/bin-updates", body);
                ui.post(() -> {
                    beep(SOUND_OK);
                    strayMove.remove(e.item.id);
                    e.item.binLocation = batchBin;
                    e.flags.remove("wrong-bin");
                    status.setText(e.item.name() + " now lives in "
                            + batchBin + " ✓");
                    // Re-check refreshes the flags from the server, then
                    // the review reopens if strays remain.
                    reloadBatchAndReview();
                });
            } catch (Exception ex) {
                ui.post(() -> {
                    beep(SOUND_ERR);
                    status.setText("Bin update failed: " + ex.getMessage());
                    showStrayReview(false);
                });
            }
        }).start();
    }

    private void startSideTrip(String bin) {
        status.setText("Setting up " + bin + "…");
        new Thread(() -> {
            try {
                JSONObject body = new JSONObject().put("bin", bin)
                        .put("created_by", prefs.getString("device", "C72"));
                JSONObject resp = api("POST",
                        "/api/batches/" + batchId + "/divert", body);
                JSONObject side = resp.getJSONObject("batch");
                final int newId = side.optInt("id");
                final String newBin = side.optString("bin_name", bin);
                final int labels = resp.optInt("labels");
                final int oldId = batchId;
                final String oldBin = batchBin;
                ui.post(() -> {
                    parentBatchId = oldId;
                    parentBinName = oldBin;
                    batchId = newId;
                    batchBin = newBin;
                    loadScanOrder();
                    loadPriorAsked();
                    strayMove.clear();
                    bItems.clear();
                    checkEntries.clear();
                    checkFlagText.clear();
                    previewItem = null;
                    pairActive = null;
                    step = STEP_PAIR;
                    beep(SOUND_OK);
                    status.setText("SIDE TRIP " + newBin + " — " + labels
                            + " label(s) queued. Pair them, then FINISH to "
                            + "get back to " + oldBin + ".");
                    applyBatchUi();
                    reloadBatchOnly();
                });
            } catch (Exception e) {
                ui.post(() -> {
                    beep(SOUND_ERR);
                    status.setText("Side trip failed: " + e.getMessage());
                });
            }
        }).start();
    }

    private void finishSideTrip() {
        new Thread(() -> {
            try {
                JSONObject resp = api("POST",
                        "/api/batches/" + batchId + "/close-divert",
                        new JSONObject());
                JSONObject parent = resp.optJSONObject("parent");
                final int backId = parent == null ? parentBatchId
                        : parent.optInt("id");
                final String backBin = parent == null ? parentBinName
                        : parent.optString("bin_name", parentBinName);
                // The batch we drop back into may ITSELF be a side trip (a
                // trip can start from inside one now). Restore ITS parent
                // pointers, so its FINISH TRIP still knows the way home.
                int gpId = parent == null ? 0
                        : parent.optInt("parent_batch_id", 0);
                String gpBin = null;
                if (gpId != 0) {
                    try {
                        gpBin = api("GET", "/api/batches/" + gpId, null)
                                .getJSONObject("batch")
                                .optString("bin_name", "?");
                    } catch (Exception ignored) {
                        gpBin = "?";
                    }
                }
                final int nextParentId = gpId;
                final String nextParentBin = gpBin;
                ui.post(() -> {
                    parentBatchId = nextParentId;
                    parentBinName = nextParentBin;
                    batchId = backId;
                    batchBin = backBin;
                    loadScanOrder();
                    loadPriorAsked();
                    strayMove.clear();
                    bItems.clear();
                    checkEntries.clear();
                    checkFlagText.clear();
                    previewItem = null;
                    pairActive = null;
                    step = STEP_CHECK;
                    beep(SOUND_OK);
                    status.setText("Back in " + backBin + ".");
                    applyBatchUi();
                    reloadBatchAndReview();
                });
            } catch (Exception e) {
                ui.post(() -> {
                    beep(SOUND_ERR);
                    status.setText("Could not close the side trip: "
                            + e.getMessage());
                });
            }
        }).start();
    }

    /** Opened or sealed? Asked once per case scan, with the note in view. */
    private void askCaseAction(String code, JSONObject box) {
        beep(SOUND_OTHER);
        int units = box == null ? 0 : box.optInt("units", 0);
        String sku = box == null ? "?" : box.optString("sku", "?");
        String title = box == null || box.isNull("product_title") ? ""
                : box.optString("product_title");
        String note = box == null || box.isNull("scan_note") ? ""
                : box.optString("scan_note");
        status.setText("Box of " + units + " — opened or sealed?");
        new AlertDialog.Builder(this)
                .setTitle("Box of " + units + " x " + sku)
                .setMessage((title.isEmpty() ? "" : title + "\n\n")
                        + (note.isEmpty() ? "" : "! " + note + "\n\n")
                        + "OPENED: counts " + units + " units and prints "
                        + units + " labels.\n\n"
                        + "SEALED: counts " + units + " units but prints ONE "
                        + "label reading \"" + units + " x " + sku + "\".")
                .setCancelable(false)
                .setPositiveButton("Opened", (d, w) ->
                        batchScanCase(code, "open"))
                .setNegativeButton("Left sealed", (d, w) ->
                        batchScanCase(code, "sealed"))
                .setNeutralButton("Skip", (d, w) -> {
                    status.setText("Box skipped — nothing counted.");
                    btInput.requestFocus();
                })
                .show();
    }

    /** Re-send the scan now that the open/sealed question is answered. */
    private void batchScanCase(String code, String action) {
        status.setText("Counting box…");
        new Thread(() -> {
            try {
                JSONObject body = new JSONObject()
                        .put("code", code).put("case_action", action);
                JSONObject resp = api("POST",
                        "/api/batches/" + batchId + "/scan", body);
                final BItem item = BItem.from(resp.getJSONObject("item"));
                final boolean sealed = "sealed".equals(action);
                ui.post(() -> {
                    BItem existing = itemById(item.id);
                    if (existing != null) {
                        bItems.set(bItems.indexOf(existing), item);
                        if (pairActive == existing) pairActive = item;
                    } else {
                        bItems.add(0, item);
                    }
                    noteScanned(item.id);
                    previewItem = item;
                    beep(SOUND_OK);
                    status.setText(item.unitsTotal + " unit(s), "
                            + item.labelsTotal + " label(s)"
                            + (sealed ? " · box left sealed." : "."));
                    updateBatchCard();
                    refreshBatchList();
                    // A case is never "the stickered box in your hand", so
                    // no uncount offer on this path.
                    maybePriorTagAlert(item, false);
                    btInput.requestFocus();
                });
            } catch (Exception e) {
                ui.post(() -> {
                    beep(SOUND_ERR);
                    status.setText("Box scan failed: " + e.getMessage());
                    btInput.requestFocus();
                });
            }
        }).start();
    }

    // ------------------------------------------------------------ station ---
    /** The canonical shelf format: one letter, 1-99, dash, 1-99 (D1-3). */
    private static boolean looksLikeBin(String code) {
        return code != null && code.trim().matches("[A-Za-z]\\d{1,2}-\\d{1,2}");
    }

    /** A bin barcode scanned while a product is up: offer to move the
     *  product there — RFID records AND Shopify — or fall through to a
     *  normal lookup (some SKUs look exactly like bin names). */
    private void askBinRelocate(String code) {
        final JSONObject p = stationProduct;
        final String bin = code.trim().toUpperCase(java.util.Locale.ROOT);
        final String was = p.isNull("bin_location") ? "none"
                : p.optString("bin_location");
        beep(SOUND_OTHER);
        new AlertDialog.Builder(this)
                .setTitle("Move it to bin " + bin + "?")
                .setMessage(p.optString("product_title", "?")
                        + "\n\nbin " + was + "  ->  " + bin
                        + "\n\nUpdates the RFID system and Shopify. If \""
                        + code + "\" is actually a product, look it up "
                        + "instead.")
                .setPositiveButton("SET BIN", (d, w) -> postBinRelocate(bin))
                .setNegativeButton("No - look it up", (d, w) ->
                        stationLookup(code))
                .show();
    }

    private void postBinRelocate(String bin) {
        final JSONObject p = stationProduct;
        final String target = p.isNull("sku")
                ? p.optString("barcode") : p.optString("sku");
        status.setText("Setting bin to " + bin + "…");
        new Thread(() -> {
            try {
                JSONObject body = new JSONObject()
                        .put("target", target)
                        .put("bin", bin)
                        .put("changed_by", prefs.getString("device", "C72"));
                api("POST", "/api/bin-updates", body);
                ui.post(() -> {
                    beep(SOUND_OK);
                    try {
                        p.put("bin_location", bin);
                    } catch (Exception ignored) {
                    }
                    stationSku.setText((p.isNull("sku") ? "no SKU"
                            : "SKU: " + p.optString("sku"))
                            + "  ·  bin " + bin);
                    status.setText(p.optString("product_title", "?")
                            + " → bin " + bin + " ✓");
                });
            } catch (Exception e) {
                ui.post(() -> {
                    beep(SOUND_ERR);
                    status.setText("Bin update failed: " + e.getMessage());
                });
            }
        }).start();
    }

    private void stationLookup(String code) {
        status.setText("Looking up " + code + "…");
        new Thread(() -> {
            try {
                String enc = URLEncoder.encode(code, "UTF-8");
                JSONObject prod = api("GET",
                        "/api/products/by-barcode/" + enc, null);
                int count = 0;
                boolean silent = false;
                try {
                    String q = prod.isNull("sku")
                            ? "barcode=" + URLEncoder.encode(
                                    prod.optString("barcode", code), "UTF-8")
                            : "sku=" + URLEncoder.encode(
                                    prod.optString("sku"), "UTF-8");
                    JSONObject tagsResp = api("GET",
                            "/api/products/tags?" + q, null);
                    count = tagsResp.optInt("count");
                    // Piggybacked "won't RFID scan" flag — the operator
                    // should know sweeps will never hear this product.
                    silent = tagsResp.optBoolean("rfid_incompatible", false);
                } catch (Exception ignored) {
                }
                final JSONObject p = prod;
                final int tagsOnFile = count;
                final boolean noScan = silent;
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
                            + "  ·  bin " + p.optString("bin_location", "—")
                            + (noScan ? "  ·  ⊘ won't RFID scan" : ""));
                    stationTracker.setText(String.valueOf(tagsOnFile));
                    loadImage(p.isNull("image_url") ? null
                            : p.optString("image_url"), stationImg);
                    beep(SOUND_OK);
                    status.setText("Trigger on the sticker to link it "
                            + "(" + tagsOnFile + " tag(s) on file)."
                            + (noScan ? " ⊘ Won't scan once it's on the "
                              + "box — pair BEFORE applying." : ""));
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
            final TagRead read = readStrongestTag(600);
            final String epc = read == null ? null : read.epc;
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
                            + "  (" + stationTags + " on file)"
                            + pickNote(read));
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
            if (sweepRunning) {
                int n;
                synchronized (tags) { n = tags.size(); }
                status.setText("Sweeping… " + n + " tag(s) — release the "
                        + "trigger to stop.");
            } else if (inBatch() && step == STEP_VERIFY && scanning) {
                int n;
                synchronized (tags) { n = tags.size(); }
                status.setText("Sweeping the bin… " + n + " unique tag(s). "
                        + "Trigger again to stop, then CHECK BIN.");
            }
        }
        locateTick();
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
