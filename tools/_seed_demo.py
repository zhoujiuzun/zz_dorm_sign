"""
样例数据（安全合并模式）：往 OSS 追加演示用户 + 半年历史，用于预览月历看板。
不覆盖真实用户。预览完用 --clear 只删演示用户，保留真实注册。

  python _seed_demo.py          # 追加演示数据
  python _seed_demo.py --clear  # 只清演示数据（张三/李四/王五）
"""
import os, sys, json, time, random
import oss2

B = os.environ.get("OSS_BUCKET", "zhouhuanzhang")
EP = "oss-cn-beijing.aliyuncs.com"
ak = os.environ.get("ALIBABA_CLOUD_ACCESS_KEY_ID")
sk = os.environ.get("ALIBABA_CLOUD_ACCESS_KEY_SECRET")
if not ak or not sk:
    sys.exit("缺少环境变量 ALIBABA_CLOUD_ACCESS_KEY_ID / _SECRET，无法访问 OSS")
bk = oss2.Bucket(oss2.Auth(ak, sk), EP, B)

DEMO = ["张三", "李四", "王五", "赵六", "钱七", "孙八", "周九", "吴十",
        "郑一", "王二", "冯小刚", "陈晓", "褚毅", "卫青", "蒋雯",
        "沈梦", "韩磊", "杨幂", "朱八戒", "秦风"]


def load(key):
    try:
        return json.loads(bk.get_object(key).read())
    except oss2.exceptions.NoSuchKey:
        return []


def put(key, data):
    bk.put_object(key, json.dumps(data, ensure_ascii=False, indent=2).encode("utf-8"))


users = load("users.json")
history = load("history.json")

# 演示数据的唯一识别依据（不依赖昵称，避免真人重名被误删）：
#   - 演示用户：openid 以 "demo" 开头
#   - 演示历史：记录带 "_demo": true 标记
def _is_demo_user(u):
    return str(u.get("openid", "")).startswith("demo")

def _is_demo_hist(h):
    return h.get("_demo") is True

# 先移除旧的演示数据（保留真实用户与真实历史）
users = [u for u in users if not _is_demo_user(u)]
history = [h for h in history if not _is_demo_hist(h)]

if len(sys.argv) > 1 and sys.argv[1] == "--clear":
    put("users.json", users)
    put("history.json", history)
    print(f"已清除演示数据，保留 {len(users)} 个真实用户")
    sys.exit(0)

# 追加演示用户
for i, name in enumerate(DEMO):
    users.append({"openid": f"demo{i}", "nickname": name,
                  "created": "2026-01-01 10:00:00"})

# 给每人分配一种出勤画像，特征各异，方便测试各种显示情况
#   ok_rate  当天签到成功概率
#   fail_rate 失败概率（其余为当天无记录）
#   start_day 从第几天前开始有数据（模拟新人只有近期数据）
PROFILES = [
    {"ok": 0.97, "fail": 0.02, "start": 185},   # 全勤型
    {"ok": 0.85, "fail": 0.10, "start": 185},   # 良好但偶尔翻车
    {"ok": 0.70, "fail": 0.08, "start": 185},   # 经常漏签
    {"ok": 0.50, "fail": 0.15, "start": 185},   # 摸鱼型
    {"ok": 0.90, "fail": 0.05, "start": 60},    # 新人（仅近2月）
    {"ok": 0.95, "fail": 0.04, "start": 30},    # 更新的新人（仅近1月）
]

now = time.time()
for i, name in enumerate(DEMO):
    p = PROFILES[i % len(PROFILES)]
    for day in range(p["start"]):
        d = time.strftime("%Y-%m-%d", time.localtime(now - day * 86400))
        r = random.random()
        if r < p["ok"]:
            t = f"21:{random.randint(0, 28):02d}"
            history.append({"nickname": name, "date": d, "time": t,
                            "status": "ok", "message": "成功", "_demo": True})
        elif r < p["ok"] + p["fail"]:
            history.append({"nickname": name, "date": d, "time": "21:35",
                            "status": "error", "message": "未在范围内", "_demo": True})
        # 否则当天无记录

put("users.json", users)
put("history.json", history)
print(f"已追加演示数据：{len(DEMO)} 演示用户，历史共 {len(history)} 条。预览完 --clear 清除。")
