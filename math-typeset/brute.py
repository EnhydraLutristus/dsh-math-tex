"""
brute.py —— 用最笨的方式（纯 Python 标量 + 打印）确认移位方向与速度，
          逐格对比 "把截图算法照抄" 与 "解析解"。
"""
import sys
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

H = 0.01
DT = 0.005
N = 1001
xs = [-2.0 + i * H for i in range(N)]
phi = lambda z: 2.718281828459045 ** (-z * z)
ptil = lambda z: -phi(-z) if z < 0 else phi(z)
idx = lambda x: int(round((x + 2.0) / H))

# ---------- 1. 移位方向 ----------
a = [0.0] * N
a[idx(0.0)] = 1.0
print("脉冲初始在 idx", a.index(1.0), " x =", xs[a.index(1.0)])
b = [0.0] + a[:-1]
print("序列 [0]+a[:-1] 后脉冲在 idx", b.index(1.0), " x =", xs[b.index(1.0)], "  -> 右移")
c = a[1:] + [0.0]
print("序列 a[1:]+[0] 后脉冲在 idx", c.index(1.0), " x =", xs[c.index(1.0)], "  -> 左移")

# ---------- 2. 逐格对比：截图写法 vs 解析解 ----------
F = [0.5 * ptil(x) for x in xs]
G = [0.5 * ptil(x) for x in xs]
K = 600          # t = 3.0
for k in range(1, K + 1):
    F = [0.0] + F[:-1]          # 右行波右移（左边补 0）
    G = G[1:] + [0.0]           # 左行波左移（右边补 0）
    G[0] = -F[0]                # <<< 截图里的"固定端反射"

print(f"\n推进 {K} 步 (t=3)，逐格对比：")
print(f"{'x':>6} {'F':>13} {'G':>13} {'F+G':>13} {'解析':>13}")
for x0 in [0.0, 0.5, 1.0, 2.0, 3.0, 5.0]:
    i = idx(x0)
    ex = 0.5 * (ptil(x0 - 3.0) + ptil(x0 + 3.0))
    print(f"{x0:>6.1f} {F[i]:>13.8f} {G[i]:>13.8f} {F[i]+G[i]:>13.8f} {ex:>13.8f}")

# ---------- 3. 去掉人工边界那一行 ----------
F = [0.5 * ptil(x) for x in xs]
G = [0.5 * ptil(x) for x in xs]
for k in range(1, K + 1):
    F = [0.0] + F[:-1]
    G = G[1:] + [0.0]
print(f"\n删掉 G[0] = -F[0] 之后：")
print(f"{'x':>6} {'F+G':>13} {'解析':>13} {'差':>13}")
for x0 in [0.0, 0.5, 1.0, 2.0, 3.0, 5.0]:
    i = idx(x0)
    ex = 0.5 * (ptil(x0 - 3.0) + ptil(x0 + 3.0))
    print(f"{x0:>6.1f} {F[i]+G[i]:>13.8f} {ex:>13.8f} {F[i]+G[i]-ex:>13.2e}")
