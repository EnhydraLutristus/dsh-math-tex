r"""
verify_wave.py —— 对截图那段推导做三件事：
  1) 逐项复算 Step 3 的四个数（发现两处算错）
  2) 复算末尾那段 F/G 离散算法，并对比"照抄写法"与"修正写法"
  3) 画快照图
运行:  D:\python\python.exe verify_wave.py
输出:  verify_wave.csv, verify_algo.csv, fig-wave.png
"""
import sys
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass
import numpy as np, csv

C = 1.0
phi = lambda z: np.exp(-np.asarray(z, float) ** 2)


def analytical(x, t):
    """半无界弦 + 固定端 u(0,t)=0：达朗贝尔解（奇延拓）"""
    x = np.asarray(x, float); tt = np.asarray(t, float)
    left = np.where(tt <= x, phi(x - tt), -phi(tt - x))   # 左行波：反射后加负号
    right = phi(x + tt)
    return 0.5 * (left + right)


# ============ 1. Step 3 四个数逐项核对 ============
print("=== 1. 截图 Step 3 逐项核对 (x=1) ===")
claims = [(0.0, "0.367879", 0.367879), (1.0, "0.509158", 0.509158),
          (1.5, "0.336701", 0.336701), (3.0, "-0.490842", -0.490842)]
rows = []
for t, txt, shown in claims:
    truth = float(analytical(1.0, t))
    ok = abs(truth - shown) < 5e-7
    print(f"  t={t:<4} 原稿 {txt:>10}  复算 {truth:+.6f}  {'一致' if ok else '不一致'}")
    rows.append([t, txt, f"{truth:+.6f}", "一致" if ok else "不一致"])
print("  错因 t=1.5: -0.388435 = -(1/2)e^{-2.5}，且整项取了负；应为 +(1/2)[-e^{-2.25}+e^{-0.25}] = +0.336701")
print("  错因 t=3  : -0.490842 = -(1/2)phi(2)，漏掉 +phi(4)；应为 +(1/2)[-phi(2)+phi(4)] = -0.009158")


# ============ 2. 离散算法两种写法对比 ============
def scheme_paper(h=0.01, cfl=0.5, T=3.0):
    """照抄截图写法：半无界 + 人工边界 G[0] = -F[0]"""
    dt = cfl * h / C
    xs = np.arange(0.0, 8.0 + h / 2, h)
    F = 0.5 * phi(xs); G = 0.5 * phi(xs)
    for _ in range(int(round(T / dt))):
        F = np.concatenate(([0.0], F[:-1]))     # 右行波右移
        G = np.concatenate((G[1:], [0.0]))      # 左行波左移
        G[0] = -F[0]                            # 截图里的"固定端反射"
    return xs, F + G


def scheme_fixed(h=0.01, cfl=0.5, T=3.0):
    """修正写法：左边界补入奇延拓值 F(0,t) = phi(-t)/2，不加任何人工边界"""
    dt = cfl * h / C
    xs = np.arange(0.0, 8.0 + h / 2, h)
    F = 0.5 * phi(xs); G = 0.5 * phi(xs)
    for k in range(1, int(round(T / dt)) + 1):
        F = np.concatenate(([0.5 * phi(-k * dt)], F[:-1]))
        G = np.concatenate((G[1:], [0.0]))
    return xs, F + G


def scheme_gbound(h=0.01, cfl=0.5, T=3.0):
    """修正写法二：整条实轴 + 奇延拓初值，迎风移位；外侧补精确奇延拓值"""
    dt = cfl * h / C
    xs = np.arange(-1.0, 8.0 + h / 2, h)
    F = 0.5 * phi(xs); G = 0.5 * phi(xs)         # phi 偶函数，两支即奇延拓的两半
    for k in range(1, int(round(T / dt)) + 1):
        F = np.concatenate(([0.5 * phi(xs[0] - k * dt)], F[:-1]))   # 入流侧精确值
        G = np.concatenate((G[1:], [0.5 * phi(xs[-1] + k * dt)]))   # 出流侧也补精确值
    return xs, F + G


def err_at(xs, u, x0=1.0, t=3.0):
    return abs(float(u[int(round((x0 - xs[0]) / (xs[1] - xs[0])))] - float(analytical(x0, t))))


xs_a, u_a = scheme_paper()
xs_b, u_b = scheme_fixed()
xs_c, u_c = scheme_gbound()
iA, iB = int(round(1.0 / 0.01)), int(round(1.0 / 0.01))
iC = int(round((1.0 - xs_c[0]) / 0.01))
ana1 = float(analytical(1.0, 3.0))
print("\n=== 2. 末尾那段 F/G 算法：照着写 vs 修正 (t=3, x=1) ===")
print(f"  照抄截图写法(半无界, G[0]=-F[0])      数值 {float(u_a[iA]):+.6f}  解析 {ana1:+.6f}  差 {err_at(xs_a,u_a):.2e}")
print(f"  修正写法一(不用人工边界, 补奇延拓值)  数值 {float(u_b[iB]):+.6f}  解析 {ana1:+.6f}  差 {err_at(xs_b,u_b):.2e}")
print(f"  修正写法二(整条实轴+奇延拓, 纯移位)   数值 {float(u_c[iC]):+.6f}  解析 {ana1:+.6f}  差 {err_at(xs_c,u_c):.2e}")
print("  说明: 半无界问题里 G 向 x=0 走、穿出边界后不再回来，所以【不需要人工边界】；")
print("        而 G[0] = -F[0] 把边界点设成正值(约 +0.5)，凭空注入一个虚假出射波。")

with open("verify_wave.csv", "w", newline="", encoding="utf-8-sig") as f:
    w = csv.writer(f); w.writerow(["t", "原稿值", "独立复算 u(1,t)", "结论"]); w.writerows(rows)
with open("verify_algo.csv", "w", newline="", encoding="utf-8-sig") as f:
    w = csv.writer(f); w.writerow(["写法", "t=3, x=1 数值", "解析", "误差"])
    w.writerow(["照抄截图(G[0]=-F[0])", f"{float(u_a[iA]):+.6f}", f"{ana1:+.6f}", f"{err_at(xs_a,u_a):.2e}"])
    w.writerow(["修正一(补奇延拓值)", f"{float(u_b[iB]):+.6f}", f"{ana1:+.6f}", f"{err_at(xs_b,u_b):.2e}"])
    w.writerow(["修正二(整条实轴)", f"{float(u_c[iC]):+.6f}", f"{ana1:+.6f}", f"{err_at(xs_c,u_c):.2e}"])

# ============ 3. 快照图 ============
try:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    plt.rcParams["font.sans-serif"] = ["Microsoft YaHei", "SimHei"]
    plt.rcParams["axes.unicode_minus"] = False
    fig, axes = plt.subplots(2, 2, figsize=(9.6, 6.0), sharey=True)
    xg = np.linspace(0, 8, 1600)
    for ax, t in zip(axes.ravel(), [0.0, 1.0, 1.5, 3.0]):
        ax.plot(xg, analytical(xg, t), lw=1.9, color="#1f4e79", label="解析解 u(x,t)")
        y1 = float(analytical(1.0, t))
        ax.plot([1.0], [y1], "o", ms=7, color="#c00", zorder=5, label="x=1")
        if t == 3.0:
            ax.plot(xs_a, u_a, "--", lw=1.3, color="#e08a00", label="照抄写法")
            ax.plot(xs_b, u_b, ":", lw=1.8, color="#2e8b57", label="修正写法")
        ax.axhline(0, color="#999", lw=0.8)
        ax.axvline(0, color="#c00", lw=1.3, ls="--")
        ax.set_title(f"t = {t:g}    u(1,t) = {y1:+.6f}", fontsize=10)
        ax.set_xlabel("x"); ax.grid(alpha=0.25); ax.set_xlim(-0.1, 8)
    axes[0, 0].legend(fontsize=7.5, loc="upper right")
    axes[1, 1].legend(fontsize=7.5, loc="upper right")
    axes[0, 0].set_ylabel("u"); axes[1, 0].set_ylabel("u")
    fig.suptitle("半无界弦固定端反射：解析解与 F/G 离散格式（红虚线为边界 x=0）", fontsize=11)
    fig.tight_layout()
    fig.savefig("fig-wave.png", dpi=160)
    print("\n  已写出 fig-wave.png")
except Exception as e:
    print("  绘图跳过:", e)

print("  已写出 verify_wave.csv, verify_algo.csv")
