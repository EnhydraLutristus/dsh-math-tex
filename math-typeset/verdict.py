"""
verdict.py
A. 原稿算法逐格对比 "c=2 的解析解" —— 判断边界规则本身对不对。
B. 只改速度（c=1，每步一格）+ 奇延拓边界 —— 给出可信版本。
C. 只改速度、却保留零填充 + G[0]=-F[0] —— 说明为什么"半格补零"仍然错。
"""
import sys
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass
import numpy as np

phi = lambda z: np.exp(-np.asarray(z, float) ** 2)
odd = lambda z: np.where(np.asarray(z) < 0.0, -phi(-np.asarray(z)), phi(np.asarray(z)))
def exact(xq, t, c=1.0):
    return 0.5 * (odd(xq - c * t) + odd(xq + c * t))

# ---------------- A ----------------
DX, DT, N = 0.01, 0.005, 1001          # 每步移一格 → c_num = DX/DT = 2
xg = -2.0 + DX * np.arange(N)
print("A  原稿算法 (dx=0.01, dt=0.005, 每步一格) 与 c=2 解析解逐格对比")
F = 0.5 * odd(xg); G = 0.5 * odd(xg)
for k in range(1, 601):
    F = np.concatenate(([0.0], F[:-1]))
    G = np.concatenate((G[1:], [0.0]))
    G[0] = -F[0]
    if k in (100, 200, 380, 600):
        t = k * DT
        u = F + G
        print(f"   t={t:>4.1f}  max|u - c2解析|={np.max(np.abs(u - exact(xg, t, 2.0))):.2e}"
              f"   max|u - c1解析|={np.max(np.abs(u - exact(xg, t, 1.0))):.2e}")

# ---------------- B ----------------
print("\nB  只把速度改对 (dx=dt=0.005 → c=1)，边界改为真正的奇延拓（对称镜像）")
DX2 = DT2 = 0.005
x2 = -3.0 + DX2 * np.arange(1801)
res = {}
F = 0.5 * odd(x2); G = 0.5 * odd(x2)
for k in range(1, 601):
    F = np.concatenate(([0.5 * odd(x2[0] - k * DT2)], F[:-1]))
    G = np.concatenate((G[1:], [0.5 * odd(x2[-1] + k * DT2)]))
    if k in (100, 200, 300, 400, 600):
        res[k] = F + G
for k in (100, 200, 300, 400, 600):
    t = k * DT2
    print(f"   t={t:>4.1f}  max|u-解析|={np.max(np.abs(res[k] - exact(x2, t))):.2e}")

# ---------------- C ----------------
print("\nC  速度改对，但保留原稿的零填充 + G[0]=-F[0]")
F = 0.5 * odd(x2); G = 0.5 * odd(x2)
for k in range(1, 601):
    F = np.concatenate(([0.0], F[:-1]))
    G = np.concatenate((G[1:], [0.0]))
    G[0] = -F[0]
    if k in (100, 200, 300, 400, 600):
        t = k * DT2
        e = np.abs((F + G) - exact(x2, t))
        print(f"   t={t:>4.1f}  max|u-解析|={np.max(e):.2e}   误差最大处 x={x2[int(np.argmax(e))]:>6.2f}")
