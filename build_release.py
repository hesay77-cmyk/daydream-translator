from pathlib import Path
import json
import re
import zipfile

ROOT = Path(__file__).resolve().parent
manifest = json.loads((ROOT / 'manifest.json').read_text(encoding='utf-8'))
release = ROOT / 'releases'
release.mkdir(exist_ok=True)
files = ['manifest.json', 'background.js', 'content.js', 'page-bridge.js',
         'webpage.js', 'options.html', 'options.js', 'options.css', 'styles.css', 'PRIVACY.html', 'LICENSE']
files += [f'icons/icon-{size}.png' for size in (16, 32, 48, 128)]
secret = re.compile(r'ark-[a-zA-Z0-9-]{12,}|sk-[a-zA-Z0-9]{12,}|AKID[a-zA-Z0-9]{10,}')
for name in files:
    source = ROOT / name
    if not source.is_file():
        raise RuntimeError(f'Missing release file: {name}')
    if source.suffix in {'.js', '.html', '.json'} and secret.search(source.read_text(encoding='utf-8')):
        raise RuntimeError(f'Potential embedded credential found in {name}; no package created')
archive = release / f'daydream-{manifest["version"]}.zip'
if archive.exists():
    raise FileExistsError(f'Preserving existing release: {archive}')
with zipfile.ZipFile(archive, 'x', compression=zipfile.ZIP_DEFLATED) as package:
    for name in files:
        package.write(ROOT / name, name)
with zipfile.ZipFile(archive) as package:
    assert package.testzip() is None
    assert 'manifest.json' in package.namelist()
    assert not any(name.startswith('test-') for name in package.namelist())
print(f'{archive}: {len(files)} runtime files; no embedded API credentials')
