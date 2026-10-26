"""Quote RN's generated Hermes shell-phase paths when the workspace folder contains spaces."""
import json
import re
from pathlib import Path
project = Path(__file__).resolve().parent.parent / 'ios/Pods/Pods.xcodeproj/project.pbxproj'
source = project.read_text()
def fix(match):
    script = json.loads(match[2])
    if '/sdks/hermes-engine/utils/build-hermes' not in script:
        return match[0]
    script = re.sub(r'(?<!")\$\{(?:REACT_NATIVE_PATH|PODS_ROOT)\}/[^\s"]+', lambda m: '"' + m[0] + '"', script)
    return match[1] + json.dumps(script) + ';'
project.write_text(re.sub(r'(\s*shellScript = )("(?:\\.|[^"\\])*");', fix, source))
# CMake TO_NATIVE_PATH adds shell escapes on macOS; VERBATIM then quotes the backslashes literally.
# Keep POSIX source paths unchanged and let VERBATIM quote each argument once.
for relative in ['API/hermes/extensions/CMakeLists.txt', 'lib/InternalJavaScript/CMakeLists.txt']:
    cmake = project.parent.parent / 'hermes-engine' / relative
    if cmake.exists():
        source = cmake.read_text()
        source = source.replace('file(TO_NATIVE_PATH ${cmake_path} native_path)', 'set(native_path "${cmake_path}")')
        cmake.write_text(source)
