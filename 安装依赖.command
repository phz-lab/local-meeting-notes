#!/bin/zsh
set -euo pipefail
cd "${0:A:h}"
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"
mkdir -p work outputs
if ! command -v brew >/dev/null; then
  print '请先从 https://brew.sh 安装 Homebrew，再重新运行此文件。'
  exit 1
fi
for package in ffmpeg whisper-cpp uv; do
  command -v "$([[ $package == whisper-cpp ]] && print whisper-cli || print $package)" >/dev/null || brew install "$package"
done
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python -r requirements.txt
scripts/build_capture.sh
model="$HOME/.cache/hyperframes/whisper/models/ggml-small.bin"
if [[ ! -f "$model" ]]; then
  mkdir -p "${model:h}"
  curl -fL --retry 3 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin' -o "$model.download"
  mv "$model.download" "$model"
fi
print '依赖已就绪，请双击「启动会议记录.command」。'
