r"""Build tc-rfid-sweep.apk without Android Studio or Gradle.

Uses a local toolchain at %LOCALAPPDATA%\rfid-android-tools (JDK 17 in
jdk\..., Android SDK in sdk\ with platforms;android-33 + build-tools;34.0.0
— installed once via sdkmanager). Steps: aapt2 link (manifest only, no res)
-> javac against android.jar + the Chainway DeviceAPI classes.jar -> d8 ->
zip in classes.dex + native libs -> zipalign -> apksigner. The signed APK
lands in app/static/ so the C72 downloads it straight from the Azure site.

Run:  py c72-app/build.py
"""
import glob
import os
import shutil
import subprocess
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))


def _find_tools() -> str:
    """Locate the toolchain.

    It was installed through the MSIX-packaged Claude app, whose writes to
    %LOCALAPPDATA% are redirected into a per-package store. So the folder
    appears at %LOCALAPPDATA%\\rfid-android-tools ONLY to processes inside
    that package; from an ordinary terminal that path does not exist, and
    the build died with a bare IndexError on the JDK glob. Check the real
    location too, and say something useful when neither is there."""
    local = os.environ.get("LOCALAPPDATA", "")
    candidates = []
    override = os.environ.get("TC_ANDROID_TOOLS")
    if override:
        candidates.append(override)
    if local:
        candidates.append(os.path.join(local, "rfid-android-tools"))
        # The packaged app's redirected LOCALAPPDATA.
        candidates.extend(sorted(glob.glob(os.path.join(
            local, "Packages", "Claude_*", "LocalCache", "Local",
            "rfid-android-tools"))))
    for path in candidates:
        if glob.glob(os.path.join(path, "jdk", "jdk-*")):
            return path
    raise SystemExit(
        "Android toolchain not found. Looked in:\n  "
        + "\n  ".join(candidates or ["(LOCALAPPDATA is not set)"])
        + "\n\nPoint TC_ANDROID_TOOLS at the folder holding jdk\\ and sdk\\ "
          "if it lives somewhere else."
    )


TOOLS = _find_tools()
JDK = glob.glob(os.path.join(TOOLS, "jdk", "jdk-*"))[0]
BT = os.path.join(TOOLS, "sdk", "build-tools", "34.0.0")
ANDROID_JAR = os.path.join(TOOLS, "sdk", "platforms", "android-33",
                           "android.jar")
AAR = glob.glob(os.path.join(HERE, "libs", "DeviceAPI_*.aar"))[0]
BUILD = os.path.join(HERE, "build")
KEYSTORE = os.path.join(HERE, "sweep.keystore")
OUT_APK = os.path.join(os.path.dirname(HERE), "app", "static",
                       "tc-rfid-sweep.apk")


def run(*cmd):
    print(">", " ".join(os.path.basename(str(c)) for c in cmd[:3]), "...")
    subprocess.run([str(c) for c in cmd], check=True)


def main():
    shutil.rmtree(BUILD, ignore_errors=True)
    os.makedirs(BUILD)

    # Unpack the Chainway AAR: classes.jar to compile/dex against, jni/
    # native libs to package.
    aar_dir = os.path.join(BUILD, "aar")
    with zipfile.ZipFile(AAR) as z:
        z.extractall(aar_dir)
    classes_jar = os.path.join(aar_dir, "classes.jar")

    # 1) Binary manifest -> base APK (no resources; UI is programmatic).
    base_apk = os.path.join(BUILD, "base.apk")
    run(os.path.join(BT, "aapt2.exe"), "link",
        "-o", base_apk,
        "--manifest", os.path.join(HERE, "AndroidManifest.xml"),
        "-I", ANDROID_JAR,
        "--min-sdk-version", "26", "--target-sdk-version", "33")

    # 2) Compile.
    cls_dir = os.path.join(BUILD, "classes")
    os.makedirs(cls_dir)
    sources = glob.glob(os.path.join(HERE, "src", "**", "*.java"),
                        recursive=True)
    # android.jar goes on the classpath (NOT bootclasspath): with the JDK's
    # own core classes available, lambdas compile under -source 8; d8 then
    # desugars for the device.
    # -encoding UTF-8 matters: without it javac decodes the sources with the
    # Windows codepage and every … ✓ — in a string ships garbled.
    run(os.path.join(JDK, "bin", "javac.exe"),
        "-source", "1.8", "-target", "1.8", "-nowarn",
        "-encoding", "UTF-8",
        "-cp", ANDROID_JAR + os.pathsep + classes_jar,
        "-d", cls_dir, *sources)

    # 3) Dex our classes together with the DeviceAPI jar.
    dex_dir = os.path.join(BUILD, "dex")
    os.makedirs(dex_dir)
    class_files = glob.glob(os.path.join(cls_dir, "**", "*.class"),
                            recursive=True)
    run(os.path.join(JDK, "bin", "java.exe"),
        "-cp", os.path.join(BT, "lib", "d8.jar"), "com.android.tools.r8.D8",
        "--release", "--lib", ANDROID_JAR, "--min-api", "26",
        "--output", dex_dir, *class_files, classes_jar)

    # 4) Assemble: dex + native libs into the APK.
    unsigned = os.path.join(BUILD, "unsigned.apk")
    shutil.copy(base_apk, unsigned)
    with zipfile.ZipFile(unsigned, "a", zipfile.ZIP_DEFLATED) as z:
        z.write(os.path.join(dex_dir, "classes.dex"), "classes.dex")
        for abi in ("arm64-v8a", "armeabi-v7a"):
            for so in glob.glob(os.path.join(aar_dir, "jni", abi, "*.so")):
                z.write(so, f"lib/{abi}/{os.path.basename(so)}")

    # 5) Align + sign (debug-grade self-signed key, kept in the repo so
    # rebuilds update-install instead of demanding an uninstall).
    aligned = os.path.join(BUILD, "aligned.apk")
    run(os.path.join(BT, "zipalign.exe"), "-f", "4", unsigned, aligned)
    if not os.path.exists(KEYSTORE):
        run(os.path.join(JDK, "bin", "keytool.exe"), "-genkeypair",
            "-keystore", KEYSTORE, "-alias", "sweep", "-keyalg", "RSA",
            "-keysize", "2048", "-validity", "10000",
            "-storepass", "telcansweep", "-keypass", "telcansweep",
            "-dname", "CN=Telescopes Canada RFID")
    run(os.path.join(JDK, "bin", "java.exe"),
        "-jar", os.path.join(BT, "lib", "apksigner.jar"), "sign",
        "--ks", KEYSTORE, "--ks-pass", "pass:telcansweep",
        "--out", OUT_APK, aligned)
    print(f"OK: {OUT_APK} ({os.path.getsize(OUT_APK)} bytes)")


if __name__ == "__main__":
    main()
