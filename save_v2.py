# -*- coding: utf-8 -*-
"""尝试覆盖原文件；被占用则存为桌面新文件，并列出锁定文件线索"""
import os, glob, traceback
import runpy, sys

SRC = r"%USERPROFILE%\Documents\deepseek-harness\default-workspace\build_interview_doc_v2.py"
TARGET = r"%USERPROFILE%\Desktop\采访.docx"
FALLBACK = r"%USERPROFILE%\Desktop\采访-参访版.docx"

# 直接复用 v2 脚本的构建逻辑，但拦截 save 目标
code = open(SRC, encoding="utf-8").read()
code = code.replace('doc.save(PATH)\nprint("saved"', 'pass\nprint("built"')
code = code.replace('PATH = r"C:\\Users\\<user>\\Desktop\\采访.docx"', 'PATH = None')
ns = {"__name__": "__main__"}
exec(compile(code, SRC, "exec"), ns)
doc = ns["doc"]

log = []
def try_save(path):
    try:
        doc.save(path)
        log.append(f"OK   -> {path} ({os.path.getsize(path)} bytes)")
        return True
    except Exception as e:
        log.append(f"FAIL -> {path} :: {type(e).__name__}: {e}")
        return False

ok = try_save(TARGET)
if not ok:
    try_save(FALLBACK)

# 列出桌面上的 Word 锁文件线索
locks = glob.glob(r"%USERPROFILE%\Desktop\~$*.docx") + glob.glob(r"%USERPROFILE%\Desktop\.~lock*")
log.append("锁文件线索: " + (", ".join(os.path.basename(x) for x in locks) if locks else "无（可能是权限或杀软占用）"))
log.append("目标文件时间戳: " + str([ (os.path.basename(f), os.path.getmtime(f)) for f in glob.glob(r"%USERPROFILE%\Desktop\采访*.docx") ]))

open(r"%USERPROFILE%\Documents\deepseek-harness\default-workspace\_save_log.txt", "w", encoding="utf-8").write("\n".join(log))
print("\n".join(log))
