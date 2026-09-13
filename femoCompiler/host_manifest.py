"""宿主能力清单（host manifest）——引擎与 harness 的词汇握手面。

引擎本身不携带任何 harness 的词汇与环境假设：thinking 档位、默认用户等
「宿主侧事实」统一从宿主清单读取。清单由接口侧提供（见
python/femo_bridge.py 的 --host-manifest 参数，引擎启动时应用一次）；
清单缺失或个别字段缺失时回落这里的内置缺省——standalone 运行（不接任何
harness）同样自圆满编译。

换 harness = 换一份清单文件，引擎零改动。
清单里不放模型目录：模型是动态的，由宿主在 job_start/check 时经协议参数
models 注入（validate_actor_sources 消费）。
"""

DEFAULT_THINKING_LEVELS = ('off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max')
DEFAULT_USER_ID = 'u001'

_thinking_levels = DEFAULT_THINKING_LEVELS
_default_user_id = DEFAULT_USER_ID


def apply_manifest(data):
    """应用宿主清单（部分应用：只认出现的键，其余保持现状）。

    返回人话 notes 列表（桥启动日志用）；格式不合法的键忽略并说明，
    绝不因清单问题炸启动。"""
    global _thinking_levels, _default_user_id
    if not isinstance(data, dict):
        return ['宿主清单格式不合法（需要 JSON 对象），已忽略，用内置缺省']
    notes = []
    levels = data.get('thinking_levels')
    if levels is not None:
        if (isinstance(levels, list) and len(levels) > 0
                and all(isinstance(x, str) and x.strip() for x in levels)):
            _thinking_levels = tuple(x.strip() for x in levels)
            notes.append(f"thinking_levels = {', '.join(_thinking_levels)}")
        else:
            notes.append('thinking_levels 不合法（需非空字符串数组），已忽略')
    user_id = data.get('default_user_id')
    if user_id is not None:
        if isinstance(user_id, str) and user_id.strip():
            _default_user_id = user_id.strip()
            notes.append(f'default_user_id = {_default_user_id}')
        else:
            notes.append('default_user_id 不合法（需非空字符串），已忽略')
    return notes


def thinking_levels():
    """当前生效的 thinking 档位全集（FEMO_parser 编译期校验用）。"""
    return _thinking_levels


def default_user_id():
    """当前生效的缺省用户 id（owner 未声明的剧本归属；soul 创建缺省）。"""
    return _default_user_id


def load_manifest_file(path):
    """读清单文件。返回 (data, err)：不存在/坏 JSON → (None, 说明文字)。"""
    import json
    import os
    if not path or not os.path.isfile(path):
        return None, f'清单文件不存在: {path}'
    try:
        with open(path, 'r', encoding='utf-8') as f:
            return json.load(f), None
    except Exception as exc:
        return None, f'清单文件读取失败: {exc}'
