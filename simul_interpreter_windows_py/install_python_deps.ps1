param (
    [string]$model = "whisper-base",
    [string]$extra_reqs_file = "requirements.txt"
)

python -m pip install "qai_hub_models[$model]~=0.48.0"
# Onnxruntime and onnxruntime-qnn conflict because they install the same binaries.
# Uninstall both to avoid conflicts. Then reinstall qnn to make sure we have the right binaries.
python -m pip uninstall --yes onnxruntime onnxruntime-qnn
python -m pip install onnxruntime-qnn==1.24.4

if ($extra_reqs_file -ne "") {
    python -m pip install -r $extra_reqs_file
}
