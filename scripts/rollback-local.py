#!/usr/bin/env python3
"""按本轮私有清单回滚 P0；--all 同时恢复项目修改前的文件，保留之前的 Kindle 布局。"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import tempfile


def atomic_json(path, data, mode):
    fd, temporary = tempfile.mkstemp(prefix='.' + path.name + '.', suffix='.tmp', dir=path.parent)
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, 'w') as output:
            json.dump(data, output, ensure_ascii=False, indent=2)
            output.write('\n')
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def rollback(backup, all_files=False):
    state = json.loads((backup / 'p0-state.json').read_text())
    hud = Path(state['hudConfig'])
    local = Path(state['localConfig'])
    hud_data = json.loads(hud.read_text())
    local_data = json.loads(local.read_text()) if local.exists() else {}
    expected = state['snapshotPath']
    for value in [hud_data.get('display', {}).get('externalUsageWritePath'), local_data.get('claudeHudUsagePath')]:
        if value not in [None, expected]:
            raise RuntimeError('适配字段已被其他操作修改，停止自动回滚，请检查备份。')
    files = []
    if all_files:
        inventory = json.loads((backup / 'project-inventory.json').read_text())
        for entry in inventory:
            target = Path(state['project']) / entry['path']
            digest = hashlib.sha256(target.read_bytes()).hexdigest() if target.exists() else None
            if digest != entry['sha256']:
                raise RuntimeError('文件在交付后已改变，停止回滚：' + entry['path'])
            files.append((target, entry))
    # 仅撤销新增字段，不覆盖后续修改的显示选项或其他本地设置。
    if 'externalUsageWritePath' in hud_data.get('display', {}):
        del hud_data['display']['externalUsageWritePath']
        atomic_json(hud, hud_data, state['hudMode'])
    if 'claudeHudUsagePath' in local_data:
        del local_data['claudeHudUsagePath']
        if not state['localConfigExisted'] and not local_data:
            local.unlink()
        else:
            atomic_json(local, local_data, state['localMode'])
    for target, entry in files:
        if entry['before'] is None:
            target.unlink()
        else:
            original = backup / entry['before']
            fd, temporary = tempfile.mkstemp(prefix='.' + target.name + '.', suffix='.tmp', dir=target.parent)
            try:
                with os.fdopen(fd, 'wb') as output:
                    output.write(original.read_bytes())
                os.chmod(temporary, entry['mode'])
                os.replace(temporary, target)
            finally:
                if os.path.exists(temporary):
                    os.unlink(temporary)
    print('已回滚 P0 配置' + ('及本轮项目文件' if all_files else '') + '。请重新启动 Dashboard。')
    print('未改动 statusLine.command、旧缓存、HUD 插件源码或生成的快照。')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('backup', type=Path)
    parser.add_argument('--all', action='store_true')
    args = parser.parse_args()
    rollback(args.backup, args.all)
