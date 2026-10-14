# -*- coding: utf-8 -*-
"""叠加原理 / 齐次化原理: 示意图 + 完整数值验证 (自洽: 数字全部现场计算)。"""
import numpy as np
from PIL import Image, ImageDraw, ImageFont

c = 1.0
gauss = lambda s, aa, sg=0.7: np.exp(-((s - aa) ** 2) / (2 * sg * sg))
phi = lambda s: gauss(s, -0.6, 0.7)
psi = lambda s: 0.6 * np.sin(2.0 * s) * np.exp(-0.3 * s * s)
src = lambda s, t: np.exp(-(s * s) / 0.6 - ((t - 1.2) ** 2) / 0.18)
x0, t0 = 2.1, 2.6


def solve(nx_target, which, want_field=False, tq=None):
    L = 10.0
    dx = 2 * L / (nx_target - 1)
    dt = dx / c
    xs = np.linspace(-L, L, nx_target)
    nsteps = max(int(round(t0 / dt)), 2)
    U = np.zeros((nsteps + 1, nx_target))
    u0 = phi(xs) if which in ("phi", "full") else np.zeros(nx_target)
    v0 = psi(xs) if which in ("psi", "full") else np.zeros(nx_target)
    f = src if which in ("src", "full") else None
    U[0] = u0
    uxx = np.zeros(nx_target)
    uxx[1:-1] = (u0[2:] - 2 * u0[1:-1] + u0[:-2]) / (dx * dx)
    f0 = 0.0 if f is None else f(xs[1:-1], 0.0)
    U[1, 1:-1] = u0[1:-1] + dt * v0[1:-1] + 0.5 * dt * dt * (c * c * uxx[1:-1] + f0)
    for n in range(1, nsteps):
        fs = 0.0 if f is None else dt * dt * f(xs[1:-1], n * dt)
        U[n + 1, 1:-1] = U[n, 2:] + U[n, :-2] - U[n - 1, 1:-1] + fs
    i = int(round((x0 + L) / dx))
    if want_field:
        return U[nsteps].copy(), xs
    return U[nsteps, i]


# ---------------- 精确值 ----------------
u_phi_ex = 0.5 * (phi(np.array([x0 - c * t0]))[0] + phi(np.array([x0 + c * t0]))[0])
xg = np.linspace(x0 - c * t0, x0 + c * t0, 800001)
u_psi_ex = np.trapezoid(psi(xg), xg) / (2 * c)
tt = np.linspace(0.0, t0, 10401)
acc = 0.0
for tk in tt:
    h = c * (t0 - tk)
    if h <= 0:
        continue
    xgg = np.linspace(x0 - h, x0 + h, max(3, int(4000 * h) + 1))
    acc += np.trapezoid(src(xgg, tk), xgg) * (tt[1] - tt[0])
u_src_ex = acc / (2 * c)
u_ex_sum = u_phi_ex + u_psi_ex + u_src_ex

NX = 8001
v_phi, v_psi, v_src, v_full = (solve(NX, k) for k in ("phi", "psi", "src", "full"))
r_super = abs(v_full - (v_phi + v_psi + v_src))
r_phi, r_psi, r_src = abs(v_phi - u_phi_ex), abs(v_psi - u_psi_ex), abs(v_src - u_src_ex)
r_full = abs(v_full - u_ex_sum)

# ψ 分量收敛阶
conv = [(n, solve(n, "psi")) for n in (4001, 8001, 16001, 32001)]
conv_err = [(n, abs(v - u_psi_ex)) for n, v in conv]
ratios = [conv_err[i][1] / conv_err[i + 1][1] for i in range(len(conv_err) - 1)]

# ---------------- 边界齐次化算例 ----------------
# u_tt=c^2 u_xx, x∈[0,1], 零初值/零边界, f=π²sin(πx)sin(πt)
#   →  精确解 u = ½(sin πt - πt·cos πt)·sin πx
def solve_bc(dxb):
    dtb = dxb / c
    nb = int(round(x1t / dxb)) + 1
    xb = np.linspace(0.0, x1t, nb)
    ntb = int(round(1.0 / dtb))
    V = np.zeros((ntb + 1, nb))
    V[1, 1:-1] = 0.5 * dtb * dtb * fb(xb[1:-1], 0.0)          # 零初值 ⇒ 起步层只有源项
    for n in range(1, ntb):
        V[n + 1, 1:-1] = (V[n, 2:] + V[n, :-2] - V[n - 1, 1:-1]
                          + dtb * dtb * fb(xb[1:-1], n * dtb))
    return V[ntb], xb


x1t = 1.0
fb = lambda x, t: np.pi ** 2 * np.sin(np.pi * x) * np.sin(np.pi * t)
u_bc_exa_f = lambda x, t: 0.5 * (np.sin(np.pi * t) - np.pi * t * np.cos(np.pi * t)) * np.sin(np.pi * x)
bc_curve, bc_x = solve_bc(0.005)
u_bc_num = bc_curve[int(round(0.5 / 0.005))]
u_bc_exa = u_bc_exa_f(0.5, 1.0)
r_bc = abs(u_bc_num - u_bc_exa)
bc_conv = []
for dxb in (0.02, 0.01, 0.005, 0.0025):
    cur, _ = solve_bc(dxb)
    bc_conv.append((dxb, abs(cur[int(round(0.5 / dxb))] - u_bc_exa)))
bc_ratios = [bc_conv[i][1] / bc_conv[i + 1][1] for i in range(len(bc_conv) - 1)]

# ---------------- 绘图 ----------------
try:
    f12 = ImageFont.truetype("C:/Windows/Fonts/msyh.ttc", 12)
    f13 = ImageFont.truetype("C:/Windows/Fonts/msyh.ttc", 13)
    f14 = ImageFont.truetype("C:/Windows/Fonts/msyh.ttc", 14)
    f16 = ImageFont.truetype("C:/Windows/Fonts/msyhbd.ttc", 16)
except Exception:
    f12 = f13 = f14 = f16 = ImageFont.load_default()

W, H = 1180, 900
img = Image.new("RGB", (W, H), (255, 255, 255))
dr = ImageDraw.Draw(img, "RGBA")
BLUE, RED, ORANGE, GRAY, GREEN = (30, 110, 200), (215, 55, 55), (226, 104, 30), (70, 70, 70), (0, 140, 110)
GRID = (176, 210, 240, 255)
SCX, SCY, CY = 96.0, 40.0, 372.0


def PT(cx, a, b):
    return (cx + SCX * a, CY - SCY * b)


def panel(cx, xspan=2.7, tmax=4.2):
    dr.line([(cx - xspan * SCX, CY), (cx + xspan * SCX, CY)], fill=GRAY, width=2)
    dr.line([(cx, CY), (cx, CY - tmax * SCY)], fill=GRAY, width=2)
    for q in np.arange(-6.0, 6.01, 0.8):
        s0, s1 = max(-xspan, q), min(xspan, q + tmax)
        if s1 > s0:
            dr.line([PT(cx, s0, s0 - q), PT(cx, s1, s1 - q)], fill=GRID, width=1)
    for p in np.arange(-6.0, 6.01, 0.8):
        s0, s1 = max(-xspan, p - tmax), min(xspan, p)
        if s1 > s0:
            dr.line([PT(cx, s0, p - s0), PT(cx, s1, p - s1)], fill=GRID, width=1)


def cone(cx, xa, ta, ttop, col):
    dr.polygon([PT(cx, xa, ta), PT(cx, xa - (ttop - ta), ttop), PT(cx, xa + (ttop - ta), ttop)],
               fill=col + (60,), outline=col + (255,))
    dr.ellipse([PT(cx, xa, ta)[0] - 5, PT(cx, xa, ta)[1] - 5,
                PT(cx, xa, ta)[0] + 5, PT(cx, xa, ta)[1] + 5], fill=col)


# ---- 左: 三个子问题各自的零锥 ----
CX1 = 300
panel(CX1)
for xa, ta, col, lab in ((-1.6, 0.45, BLUE, "u^φ"), (0.0, 0.45, GREEN, "u^ψ"), (1.6, 0.45, ORANGE, "u^f")):
    ttop = min(3.2, ta + 1.9)
    cone(CX1, xa, ta, ttop, col)
for lab, col, lx, ax in (("u^φ", BLUE, -1.2, -1.6), ("u^ψ", GREEN, 0.5, 0.0), ("u^f", ORANGE, 1.9, 1.6)):
    lp = PT(CX1, lx, 0.62)
    ap = PT(CX1, ax, 0.45)
    dr.line([ap, (lp[0], lp[1] + 16)], fill=col + (150,), width=1)
    dr.text(lp, lab, fill=col, font=f14)
dr.text((36, 22), "左: 齐次问题的叠加 (线性性)", fill=(20, 20, 20), font=f16)
dr.text((36, 48), "φ: 初位移     ψ: 初速度     f: 源项 (非齐次)", fill=(60, 60, 60), font=f13)
dr.text((36, 68), "三者各自的解 u^φ, u^ψ, u^f 各占一个零锥, 直接相加即得全解。", fill=(60, 60, 60), font=f13)
dr.text((36, 408), "叠加原理的根由: 方程与定解条件都是线性的 → 解算子线性;", fill=(60, 60, 60), font=f13)
dr.text((36, 428), "更一般地, 非齐次项也可拆成若干项分别求解后相加。", fill=(60, 60, 60), font=f13)

# ---- 中: 齐次化原理 ----
CX2 = 790
panel(CX2)
for tau, xa, col in ((0.4, -1.5, BLUE), (1.2, 0.0, ORANGE), (2.0, 1.5, RED)):
    ttop = min(3.2, tau + 1.5)
    cone(CX2, xa, tau, ttop, col)
    dr.line([PT(CX2, -2.7, tau), PT(CX2, 2.7, tau)], fill=col + (150,), width=2)
    dr.text((PT(CX2, 2.74, tau)[0], PT(CX2, 2.74, tau)[1] - 8), "τ=%.1f" % tau, fill=col, font=f12)
dr.text((620, 22), "中: 齐次化原理 (Duhamel, 冲量叠加)", fill=(20, 20, 20), font=f16)
dr.text((620, 48), "u^f(x,t) = ∫_0^t v(x,t;τ) dτ : 把源 f 切成无数瞬时冲量,", fill=(60, 60, 60), font=f13)
dr.text((620, 68), "τ 时刻的冲量“点火”后按齐次方程自由传播 (各自的零锥),", fill=(60, 60, 60), font=f13)
dr.text((620, 88), "再沿 τ 积分叠加起来 —— 与左图的“相加”是同一件事。", fill=(60, 60, 60), font=f13)
dr.text((620, 408), "一维具体形式 = 过去零锥上的二重积分:", fill=(60, 60, 60), font=f13)
dr.text((620, 428), "u^f = (1/2c) ∬_{|ξ-x| ≤ c(t-τ)} f(ξ,τ) dξ dτ", fill=ORANGE, font=f14)

# ---- 下左: 边界齐次化算例的波形 ----
bx0, bx1, by0, by1 = 40.0, 560.0, 470.0, 606.0
dr.rectangle([bx0, by0, bx1, by1], outline=(205, 214, 224))
dr.line([(bx0 + 10, by1 - 22), (bx1 - 10, by1 - 22)], fill=GRAY, width=1)
dr.line([(bx0 + 10, by1 - 22), (bx0 + 10, by0 + 10)], fill=GRAY, width=1)


def bxy(xx, yy):
    return (bx0 + 10 + (bx1 - bx0 - 20) * xx, (by1 - 22) - (by1 - by0 - 34) * yy / 1.7)


pts = [bxy(x_, v) for x_, v in zip(bc_x, bc_curve)]
dr.line(pts, fill=BLUE, width=2)
xs_f = np.linspace(0.0, 1.0, 401)
dr.line([bxy(x_, u_bc_exa_f(x_, 1.0)) for x_ in xs_f], fill=RED, width=1)
dr.text((bx0 + 14, by0 + 8), "t = 1.0 时的波形 (边界齐次化算例)", fill=(20, 20, 20), font=f13)
dr.text((bx0 + 14, by0 + 28), "精确 u = ½(sin πt - πt·cos πt)·sin πx (红)", fill=RED, font=f12)
dr.text((bx0 + 14, by0 + 46), "数值解 (蓝) 与之重合", fill=BLUE, font=f12)

# ---- 下右: 数值验证文字 ----
TX = 590
dr.text((TX, 494), "数值验证 (蛙跳格式, CFL=1, 观察点 x0=%.1f, t0=%.1f, nx=%d):" % (x0, t0, NX),
        fill=(20, 20, 20), font=f16)
dr.text((TX, 524), "① u = ½[φ(x0-ct0)+φ(x0+ct0)] + (1/2c)∫ψ + (1/2c)∬f :", fill=(20, 20, 20), font=f13)
dr.text((TX, 544), "   u^φ=%+.9f  u^ψ=%+.9f" % (u_phi_ex, u_psi_ex), fill=(60, 60, 60), font=f13)
dr.text((TX, 562), "   u^f=%+.9f  Σ=%+.9f" % (u_src_ex, u_ex_sum), fill=(60, 60, 60), font=f13)
dr.text((TX, 590), "② 子算例与精确值之差: φ %.1e, ψ %.1e, f %.1e" % (r_phi, r_psi, r_src),
        fill=GREEN, font=f13)
dr.text((TX, 610), "   |全量 - (u^φ+u^ψ+u^f)| = %.1e  ← 叠加原理" % r_super, fill=GREEN, font=f13)
dr.text((TX, 630), "   |全量 - Σ精确| = %.1e  ← 离散误差" % r_full, fill=GREEN, font=f13)
dr.text((TX, 658), "③ ψ 分量二阶收敛: nx = " + ", ".join("%d" % n for n, _ in conv_err), fill=(20, 20, 20), font=f12)
dr.text((TX, 676), "   误差 " + ", ".join("%.1e" % e for _, e in conv_err), fill=(60, 60, 60), font=f12)
dr.text((TX, 694), "   误差比 " + ", ".join("%.2f" % r for r in ratios) + "  (理论 4.00)", fill=GREEN, font=f12)
dr.text((TX, 722), "④ 边界齐次化收敛: dx = " + ", ".join("%.4f" % d for d, _ in bc_conv), fill=(20, 20, 20), font=f12)
dr.text((TX, 740), "   误差 " + ", ".join("%.1e" % e for _, e in bc_conv), fill=(60, 60, 60), font=f12)
dr.text((TX, 758), "   误差比 " + ", ".join("%.2f" % r for r in bc_ratios), fill=GREEN, font=f12)
dr.text((TX, 786), "在 (x,t)=(0.5,1.0): 数值 %+.8f, 精确 %+.8f" % (u_bc_num, u_bc_exa), fill=(60, 60, 60), font=f12)
dr.text((30, 838), "要点: 叠加原理把“多源”问题拆成“单源”问题之和; 齐次化原理把“非齐次”问题化为“齐次”问题族 —— 线性性的两个侧面。",
        fill=(20, 20, 20), font=f13)
dr.text((30, 860), "两者都只是同一个线性叠加结构的不同用法 (Duhamel 就是“把源项也当成一族初值”)。",
        fill=(20, 20, 20), font=f13)

img.save("superposition_duhamel.png")
print("已保存 superposition_duhamel.png")
print("精确: u^φ=%.9f u^ψ=%.9f u^f=%.9f Σ=%.9f" % (u_phi_ex, u_psi_ex, u_src_ex, u_ex_sum))
print("② 子算例误差: φ %.2e  ψ %.2e  f %.2e" % (r_phi, r_psi, r_src))
print("   叠加性 |全量-Σ三部分| = %.2e     全量-精确 = %.2e" % (r_super, r_full))
print("③ ψ 收敛: " + ", ".join("nx=%d err=%.1e" % (n, e) for n, e in conv_err))
print("   误差比: " + ", ".join("%.2f" % r for r in ratios))
print("④ 边界齐次化: 数值 %.9f  精确 %.9f  差 %.2e" % (u_bc_num, u_bc_exa, r_bc))
print("   收敛: " + ", ".join("dx=%.4f err=%.1e" % (d, e) for d, e in bc_conv))
print("   误差比: " + ", ".join("%.2f" % r for r in bc_ratios))
