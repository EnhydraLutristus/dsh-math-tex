"""
final_fix.py —— 定论版
BUG 1  速度：每步移动 c*dt/dx 格。原稿 dx=0.01, dt=0.005 → 隐含 c=2，题目 c=1。
BUG 2  边界：零填充 + G[0] = -F[0] 只保证边界值 u(0,t)=0，
       但固定端要求 F(0,t) = -G(0,t)（反射波必须由 G[0] 注入 F），
       正确注入后误差降到机器精度。
产出：fig-fix.png（三联图）
"""
import sys
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

plt.rcParams["font.sans-serif"] = ["Microsoft YaHei", "SimHei", "DejaVu Sans"]
plt.rcParams["axes.unicode_minus"] = False

phi = lambda z: np.exp(-np.asarray(z, float) ** 2)
odd = lambda z: np.where(np.asarray(z) < 0.0, -phi(-np.asarray(z)), phi(np.asarray(z)))
exact = lambda xq, t: 0.5 * (odd(xq - t) + odd(xq + t))

DX = DT = 0.005
x = DX * np.arange(1601)                     # 0 .. 8，每步一格 (c=1)

def run(T, boundary):
    F = 0.5 * phi(x); G = 0.5 * phi(x)
    for k in range(1, int(round(T / DT)) + 1):
        F = np.concatenate(([0.0], F[:-1]))          # 右行波右移一格
        G = np.concatenate((G[1:], [0.0]))           # 左行波左移一格
        if boundary == "paper":                      # 原稿：只写 G[0]
            G[0] = -F[0]
        else:                                        # 修正：两个方向都注入
            F[0] = -G[0]
            G[0] = -F[0]
    return F + G

print("域 x∈[0,8]，dx=dt=0.005（c=1，每步一格），初值 F=G=0.5φ(x)")
print(f"{'t':>5} {'原稿边界 max|u-解析|':>22} {'修正边界 max|u-解析|':>22}")
errs = {}
for T in (0.5, 1.0, 1.5, 2.0, 3.0):
    e1 = np.max(np.abs(run(T, "paper") - exact(x, T)))
    e2 = np.max(np.abs(run(T, "fixed") - exact(x, T)))
    errs[T] = (e1, e2)
    print(f"{T:>5.1f} {e1:>22.3e} {e2:>22.3e}")

# ---------------- 画图 ----------------
fig, ax = plt.subplots(1, 3, figsize=(16.5, 4.6))

# (a) 原稿速度 vs 题目速度
xg = -2.0 + 0.01 * np.arange(1001)
Fp = 0.5 * odd(xg); Gp = 0.5 * odd(xg)
for k in range(1, 101):
    Fp = np.concatenate(([0.0], Fp[:-1])); Gp = np.concatenate((Gp[1:], [0.0])); Gp[0] = -Fp[0]
ax[0].plot(xg, Fp + Gp, lw=2, color="crimson", label="原稿算法 (隐含 c=2)")
ax[0].plot(xg, exact(xg, 0.5), "k--", lw=1.6, label="题目解 (c=1), t=0.5")
ax[0].axvline(0, color="gray", lw=3, alpha=.5)
ax[0].set_title("(a) t=0.5：波前位置差一倍", fontsize=11)
ax[0].legend(fontsize=9); ax[0].grid(alpha=.25); ax[0].set_xlim(-1.5, 3.5)

# (b) t=1.5 原稿 vs 正确解
K = 300
Fp = 0.5 * odd(xg); Gp = 0.5 * odd(xg)
for k in range(1, K + 1):
    Fp = np.concatenate(([0.0], Fp[:-1])); Gp = np.concatenate((Gp[1:], [0.0])); Gp[0] = -Fp[0]
ax[1].plot(xg, Fp + Gp, lw=2, color="crimson", label="原稿算法")
ax[1].plot(xg, exact(xg, 1.5), "k--", lw=1.6, label="解析解")
ax[1].axhline(0, color="gray", lw=.8)
ax[1].set_title("(b) t=1.5：解析解在 x=1 处已是 −0.3884", fontsize=11)
ax[1].legend(fontsize=9); ax[1].grid(alpha=.25); ax[1].set_xlim(-1.5, 5.0)

# (c) 边界注入：原稿 vs 修正
up = run(1.0, "paper"); uf = run(1.0, "fixed")
ax[2].plot(x[:420], up[:420], lw=2, color="crimson", label="零填充 + G[0]=−F[0]")
ax[2].plot(x[:420], uf[:420], lw=2, color="seagreen", label="修正: F[0]=−G[0] 且 G[0]=−F[0]")
ax[2].plot(x[:420], exact(x[:420], 1.0), "k--", lw=1.6, label="解析解")
ax[2].set_title("(c) t=1 波前放大：原稿在 x<t 处整格丢失反射波", fontsize=11)
ax[2].legend(fontsize=9); ax[2].grid(alpha=.25)

plt.tight_layout()
plt.savefig("fig-fix.png", dpi=140)
print("\n已保存 fig-fix.png")
