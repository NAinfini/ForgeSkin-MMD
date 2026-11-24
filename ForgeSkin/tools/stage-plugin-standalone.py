# MMD 版（独立仓库布局）从源码构建插件并暂存到 artifacts/forge-skin-release/publish/plugin。
# 上游 ForgeSkin/tools/build-editor-release.ps1 假定仓库里有 Mods/ 且需要 PowerShell 7，这里两份都没有；
# 这个脚本做同样的事，只用到 .NET SDK 和 Python：
#   1. dotnet build ForgeSkin/ForgeSkin.csproj（连同 ForgeCore）到 artifacts/forge-skin-release/dotnet
#   2. 按 Release/release.json 里 NAinfini-ForgeCore 的文件清单拼出 publish/plugin/{ForgeSkin,ForgeCore}
# 用法:
#   python ForgeSkin/tools/stage-plugin-standalone.py --bepinex "<配置档>\BepInEx"
# 不给 --bepinex 时读环境变量 GTFO_BEPINEX_PATH。
import argparse
import json
import os
import shutil
import subprocess
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
OUT = os.path.join(ROOT, 'artifacts', 'forge-skin-release')
BUILD = os.path.join(OUT, 'dotnet')
PLUGIN = os.path.join(OUT, 'publish', 'plugin')
CORE_FILES = ('manifest.json', 'icon.png', 'README.md', 'CHANGELOG.md', 'LICENSE', 'NOTICE', 'web-manifest.forge')
CORE_SKIP = ('manifest.json', 'icon.png', 'README.md', 'CHANGELOG.md')


def main() -> int:
    parser = argparse.ArgumentParser(description='Build ForgeSkin and ForgeCore from source and stage publish/plugin.')
    parser.add_argument('--bepinex', default=os.environ.get('GTFO_BEPINEX_PATH'),
                        help='<profile>/BepInEx with generated interop assemblies (default: GTFO_BEPINEX_PATH)')
    args = parser.parse_args()
    if not args.bepinex:
        print('give --bepinex "<profile>\\BepInEx" or set GTFO_BEPINEX_PATH', file=sys.stderr)
        return 2
    bepinex = os.path.abspath(args.bepinex)
    if not os.path.isfile(os.path.join(bepinex, 'core', 'BepInEx.Unity.IL2CPP.dll')):
        print(f'{bepinex} is not a BepInEx IL2CPP profile with interop assemblies', file=sys.stderr)
        return 2

    print('== plugin (Release)')
    subprocess.run(['dotnet', 'build', os.path.join(ROOT, 'ForgeSkin', 'ForgeSkin.csproj'),
                    '-c', 'Release', '--artifacts-path', BUILD,
                    f'-p:GTFOBepInExPath={bepinex}', '-v', 'q', '--nologo', '--disable-build-servers'],
                   cwd=ROOT, check=True)

    print('== stage publish/plugin')
    shutil.rmtree(PLUGIN, ignore_errors=True)
    skin = os.path.join(PLUGIN, 'ForgeSkin')
    core = os.path.join(PLUGIN, 'ForgeCore')
    for folder in (skin, core, os.path.join(skin, 'lang'), os.path.join(core, 'lang'), os.path.join(core, 'fonts')):
        os.makedirs(folder, exist_ok=True)

    shutil.copy2(os.path.join(BUILD, 'bin', 'ForgeSkin', 'release', 'ForgeSkin.Plugin.dll'), skin)
    for name in ('en.forge', 'zh.forge'):
        shutil.copy2(os.path.join(ROOT, 'ForgeSkin', 'lang', name), os.path.join(skin, 'lang', name))

    for name in ('ForgeCore.dll', 'NVorbis.dll'):
        shutil.copy2(os.path.join(BUILD, 'bin', 'ForgeCore', 'release', name), core)
    with open(os.path.join(ROOT, 'Release', 'release.json'), encoding='utf-8') as f:
        release = json.load(f)
    row = next(r for r in release['libraries'] if r.get('packageName') == 'NAinfini-ForgeCore')
    licence = next(b for b in row['bundledLibraries'] if b['licenseFile'] == 'NVorbis.LICENSE.forge')
    with open(os.path.join(core, 'NVorbis.LICENSE.forge'), 'w', encoding='utf-8', newline='\n') as f:
        f.write(licence['licenseText'])
    for name in CORE_FILES:
        shutil.copy2(os.path.join(ROOT, 'ForgeCore', name), core)
    for name in ('en.forge', 'zh.forge'):
        shutil.copy2(os.path.join(ROOT, 'ForgeCore', 'lang', name), os.path.join(core, 'lang', name))
    fonts = os.path.join(core, 'fonts')
    for name in ('OFL-GlowSans.forge', 'OFL-Rajdhani.forge'):
        shutil.copy2(os.path.join(ROOT, 'ForgeCore', 'Assets', 'fonts', name), fonts)
    # The UI font bundle is local-only media (never in Git): take it from the installed profile when it has one.
    installed = os.path.join(bepinex, 'plugins', 'NAinfini-ForgeCore', 'ForgeCore', 'fonts', 'ForgeUI-fonts.bundle')
    if os.path.isfile(installed):
        shutil.copy2(installed, fonts)
    else:
        print('warning: ForgeUI-fonts.bundle not found; the staged ForgeCore has no UI fonts', file=sys.stderr)

    for need in ('ForgeSkin/ForgeSkin.Plugin.dll', 'ForgeCore/ForgeCore.dll'):
        if not os.path.isfile(os.path.join(PLUGIN, *need.split('/'))):
            print(f'staged plugin lacks {need}', file=sys.stderr)
            return 1
    print(f'  {PLUGIN}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())