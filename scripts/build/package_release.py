#!/usr/bin/env python3
"""Package committed application sources and the compiled UI without local data."""
import hashlib
import pathlib
import subprocess
import sys
import zipfile

root = pathlib.Path(__file__).resolve().parents[2]
output = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else '/workspace/release-artifacts').resolve()
output.mkdir(parents=True, exist_ok=True)
version = '1.0.0'
prefix = f'Portable-Local-Studio-{version}'
archive = output / f'{prefix}.zip'
tracked = subprocess.check_output(['git', 'ls-files', '-z'], cwd=root).decode().split('\0')
dist = root / 'app/dist'
if not (dist / 'index.html').is_file():
    raise SystemExit('Build the frontend before packaging.')
with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as bundle:
    for name in sorted(filter(None, tracked)):
        if name.startswith('.github/'):
            continue
        source = root / name
        if source.is_file():
            bundle.write(source, f'{prefix}/{name}')
    for source in sorted(dist.rglob('*')):
        if source.is_file():
            bundle.write(source, f'{prefix}/{source.relative_to(root)}')
checksum = hashlib.sha256(archive.read_bytes()).hexdigest()
(output / 'SHA256SUMS').write_text(f'{checksum}  {archive.name}\n')
print(archive)
