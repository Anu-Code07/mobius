#!/bin/sh
# Builds mobius-agent.dex (embedded into mobius-driver at compile time). Needs a JDK and the Android SDK.
set -e
cd "$(dirname "$0")"
SDK="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
JAR="$SDK/platforms/$(ls "$SDK/platforms" | sort -V | tail -1)/android.jar"
D8="$SDK/build-tools/$(ls "$SDK/build-tools" | sort -V | tail -1)/d8"
rm -rf build && mkdir -p build/classes
javac -source 11 -target 11 -nowarn -classpath "$JAR" -d build/classes $(find src -name '*.java') 2>&1 | grep -v "^warning\|^Note\|bootstrap class path" || true
"$D8" --min-api 26 --lib "$JAR" --output build $(find build/classes -name '*.class')
mv build/classes.dex mobius-agent.dex
rm -rf build
ls -la mobius-agent.dex
