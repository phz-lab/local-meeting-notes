#!/bin/zsh
set -euo pipefail
cd "${0:A:h}/.."
app="work/MeetingAudioCapture.app"
mkdir -p "$app/Contents/MacOS"
cp native/Info.plist "$app/Contents/Info.plist"
swiftc -swift-version 5 -parse-as-library -O native/AudioCapture.swift -o "$app/Contents/MacOS/MeetingAudioCapture" -framework ScreenCaptureKit -framework AVFoundation -framework CoreMedia -framework CoreGraphics -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker native/Info.plist
codesign --force --sign - "$app"
