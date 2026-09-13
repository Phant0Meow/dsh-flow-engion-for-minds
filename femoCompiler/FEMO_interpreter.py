"""
FEMO Interpreter — 命令行入口与打印工具
"""
import re
import os
import sys
from typing import Any

# 从新解析器导入所有必要的数据类和函数
from .FEMO_parser import (
    parse_script,
    Script, ModuleDef, ActionDef, FlowGraph, FlowNode, FlowEdge,
    ExecutorType, OutType, ActorRef, DynamicActorRef, VarRef,
    ActorDef, OutDef, InMapping, MethodDef,
)


def pprint_scope(scope_list):
    ss = []
    for s in scope_list:
        if isinstance(s, DynamicActorRef):
            ss.append(f"@{{{s.var_name}}}")
        elif isinstance(s, ActorRef):
            ss.append(f"@{s.name}" + (f".{s.attribute}" if s.attribute else ""))
        elif isinstance(s, VarRef):
            ss.append(f"{{{s.name}}}")
        else:
            ss.append(str(s))
    return f"[{', '.join(ss)}]"


def pprint_script(script: Script) -> str:
    L = []
    L.append("=" * 60)
    L.append("[interpreter]FEMO Script Parse Result")
    L.append("=" * 60)

    L.append("\n📋 META:")
    for k, v in script.meta.items():
        L.append(f"[interpreter]{k} = {v!r}")

    L.append("\n📦 VARS:")
    for k, v in script.vars.items():
        L.append(f"[interpreter]{k} = {v!r}")

    L.append("\n🔌 CODE:")
    for k, v in script.code.items():
        L.append(f"[interpreter]{k} = {v!r}")

    L.append("\n🎭 ACTORS:")
    for n, ad in script.actors.items():
        bp = " [blueprint]" if ad.is_blueprint else ""
        L.append(f"[interpreter]{ad.type.value} {n}{bp}")
        L.append(f"[interpreter]soul={ad.soul}, source={ad.source!r}, tools={ad.tools}")

    L.append("\n⚡ ACTIONS:")
    for n, ad in script.actions.items():
        as_s = f" as({ad.as_actor})" if ad.as_actor else ""
        L.append(f"[interpreter]action {n} @{ad.executor_type.value}({ad.executor_param}){as_s}:")
        if ad.prompt:
            pv = ad.prompt.replace('\n', '\\n')
            L.append(f"[interpreter]prompt: \"{pv[:70]}{'...' if len(pv)>70 else ''}\"")
        if ad.scope:
            L.append(f"[interpreter]scope: {pprint_scope(ad.scope)}")
        for im in ad.in_mappings:
            L.append(f"[interpreter]in: {im.local_name} = {im.global_expr}")
        for od in ad.outs:
            if od.out_type == OutType.ASSIGN:
                L.append(f"[interpreter]out: {od.var_name}")
            else:
                dk = f".{od.dynamic_key}" if od.dynamic_key else ""
                extras = ""
                if od.choices: extras += f", choices={od.choices}"
                L.append(f"[interpreter]out: {od.var_name}{dk}({od.out_type.value}, \"{od.label}\"{extras})")
        if ad.resolve: L.append(f"[interpreter]resolve: {ad.resolve}")
        if ad.max_retries: L.append(f"[interpreter]max_retries: {ad.max_retries}")
        if ad.fallback: L.append(f"[interpreter]fallback: {ad.fallback}")
        if ad.memory: L.append(f"[interpreter]memory: {ad.memory}")
        if ad.context: L.append(f"[interpreter]context: {ad.context}")
        if ad.interrupt: L.append(f"[interpreter]interrupt: {ad.interrupt}")

    L.append("\n🧠 MEMORIES:")
    for n, md in script.memories.items():
        L.append(f"[interpreter]memory {n}({md.module_alias}.{md.func_name}):")
        if md.in_params: L.append(f"[interpreter]in: {', '.join(md.in_params)}")
        for od in md.out_defs:
            L.append(f"[interpreter]out: {od.var_name}({od.out_type.value})")

    L.append("\n📖 CONTEXTS:")
    for n, cd in script.contexts.items():
        L.append(f"[interpreter]context {n}({cd.module_alias}.{cd.func_name}):")
        if cd.in_params: L.append(f"[interpreter]in: {', '.join(cd.in_params)}")
        for od in cd.out_defs:
            L.append(f"[interpreter]out: {od.var_name}({od.out_type.value})")

    L.append("\n📦 MODULES:")
    for n, md in script.modules.items():
        L.append(f"[interpreter]module {n}({', '.join(md.params)}):")
        if md.locals: L.append(f"[interpreter]locals: {md.locals}")
        for an, ad in md.actions.items():
            L.append(f"[interpreter]action {an} @{ad.executor_type.value}({ad.executor_param}):")
            if ad.prompt: L.append(f"[interpreter]  prompt: \"{ad.prompt[:60]}\"")
            if ad.scope: L.append(f"[interpreter]  scope: {pprint_scope(ad.scope)}")
            for od in ad.outs:
                if od.out_type == OutType.ASSIGN:
                    L.append(f"[interpreter]  out: {od.var_name}")
                else:
                    dk = f".{od.dynamic_key}" if od.dynamic_key else ""
                    L.append(f"[interpreter]  out: {od.var_name}{dk}({od.out_type.value}, \"{od.label}\")")
        if md.flow:
            L.append(f"[interpreter]internal_flow:")
            for nid, node in md.flow.nodes.items():
                parts = [f"      [{nid}]"]
                if node.type in ('start',): parts.append("[START]")
                elif node.type in ('end',): parts.append("[END]")
                if node.action_name: parts.append(f"action:{node.action_name}")
                if node.module_ref: parts.append(f"module:{node.module_ref}")
                L.append(' '.join(parts))
            for e in md.flow.edges:
                c = f" (if {e.condition})" if e.condition else ""
                L.append(f"[interpreter]  {e.source} -> {e.target}{c}")

    if script.flow:
        L.append("\n🌊 FLOW GRAPH:")
        entry = script.flow.entry
        L.append(f"[interpreter]Entry: {entry}")
        L.append(f"[interpreter]Nodes ({len(script.flow.nodes)}):")
        for lb, nd in script.flow.nodes.items():
            prefix = f"[interpreter][{lb}]"
            # 节点类型标识
            if nd.type == 'start':
                L.append(f"{prefix} [START]")
            elif nd.type == 'break':
                L.append(f"{prefix} [BREAK]")
            elif nd.type == 'end':
                L.append(f"{prefix} [END]")
            elif nd.type == 'gateway':
                gw = nd.meta.get('gw_kind', '')
                if gw in ('for', 'par'):
                    L.append(f"{prefix} GATEWAY:{gw.upper()} var={nd.meta.get('var_name','')} in={nd.meta.get('iterable','')}")
                elif gw == 'fork':
                    L.append(f"{prefix} GATEWAY:FORK")
                elif gw == 'join':
                    L.append(f"{prefix} GATEWAY:JOIN({nd.meta.get('join_mode','')})")
            elif nd.module_ref:
                L.append(f"{prefix} → &{nd.module_ref}")
            elif nd.action_name:
                L.append(f"{prefix} → action:{nd.action_name}")
            else:
                L.append(f"{prefix}")
            # 打印附着在该节点上的裸动作
            if nd.extra_actions:
                for ea in nd.extra_actions:
                    L.append(f"      [extra] {ea}")
        L.append(f"[interpreter]Edges ({len(script.flow.edges)}):")
        for e in script.flow.edges:
            c = f" (if {e.condition})" if e.condition else ""
            L.append(f"[interpreter]{e.source} -> {e.target}{c}")

    return '\n'.join(L)



