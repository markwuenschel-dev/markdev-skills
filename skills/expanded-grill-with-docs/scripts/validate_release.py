#!/usr/bin/env python3
from pathlib import Path
import json, re, sys, py_compile
try:
    import yaml
except Exception as exc:
    print(f"EGWD320-ENV: PyYAML unavailable: {exc}")
    raise
ROOT=Path(__file__).resolve().parents[1]
SKILLS=ROOT.parent
F=[]
def finding(code,msg): F.append(f"{code}: {msg}")
def load_yaml(p):
    try: return yaml.safe_load(p.read_text(encoding='utf-8'))
    except Exception as e: finding('EGWD320-PARSE',f'{p.relative_to(ROOT)}: {e}'); return None
def check_required():
    req=['SKILL.md','CHANGELOG.md','assets/skill-contract.json','assets/evaluation-suite.json','assets/evidence-recon-ref.yaml','assets/lane-result.yaml','assets/flat-decision-set.yaml','assets/decision-graph.yaml','references/migration-v3.1-to-v3.2.md']
    for rel in req:
        if not (ROOT/rel).exists(): finding('EGWD320-MISSING',rel)
    for rel in ['shared/evidence-recon/MANIFEST.json','shared/evidence-recon/evidence-recon.js','shared/evidence-recon/evidence-packet.schema.json']:
        if not (SKILLS/rel).exists(): finding('EGWD320-DEPENDENCY',rel)
def check_parse():
    for p in ROOT.rglob('*.json'):
        try: json.loads(p.read_text(encoding='utf-8'))
        except Exception as e: finding('EGWD320-PARSE',f'{p.relative_to(ROOT)}: {e}')
    for p in ROOT.rglob('*.yaml'): load_yaml(p)
def check_contract():
    c=json.loads((ROOT/'assets/skill-contract.json').read_text())
    if c.get('version')!='3.2.0': finding('EGWD320-IDENTITY','contract version')
    em=c.get('policy',{}).get('evidence_model',{})
    if em.get('canonical_contract')!='shared/evidence-recon evidence packet v1': finding('EGWD320-EVIDENCE','canonical contract')
    if em.get('evidence_discipline_required') is not True or em.get('heavy_dispatch_required') is not False: finding('EGWD320-EVIDENCE','mode invariants')
    boundary=(em.get('consumer_boundary') or '').lower()
    for term in ['mandatory decision-coverage sweep','human decision','flat-vs-graph']:
        if term not in boundary: finding('EGWD320-BOUNDARY',term)
def check_skill():
    t=(ROOT/'SKILL.md').read_text(encoding='utf-8').lower()
    for phrase in ['shared/evidence-recon','inline mode','expedition mode','negative-claim receipt','does not determine whether every consequential decision dimension','mandatory decision-coverage sweep']:
        if phrase not in t: finding('EGWD320-SKILL',f'missing {phrase}')
    if re.search(r'evidence (?:packet|recon).{0,80}(?:replaces|waives) the mandatory decision',t): finding('EGWD320-BOUNDARY','evidence replaces decision sweep')
def check_evals():
    d=json.loads((ROOT/'assets/evaluation-suite.json').read_text())
    if d.get('suite_id')!='expanded-grill-with-docs-v3.2.0' or d.get('version')!='3.2.0': finding('EGWD320-EVAL','suite identity')
    ids=[c.get('id') for c in d.get('cases',[])]
    if len(ids)!=len(set(ids)): finding('EGWD320-EVAL','duplicate IDs')
    if len(ids)<59: finding('EGWD320-EVAL',f'expected >=59 cases, got {len(ids)}')
    need={'evidence-inline-proportional-054','evidence-expedition-wide-055','evidence-negative-receipt-056','evidence-not-decision-coverage-057','evidence-discoverable-fact-058','evidence-expedition-failure-059'}
    if need-set(ids): finding('EGWD320-EVAL',f'missing {sorted(need-set(ids))}')
def check_assets():
    flat=load_yaml(ROOT/'assets/flat-decision-set.yaml') or {}
    graph=load_yaml(ROOT/'assets/decision-graph.yaml') or {}
    lane=load_yaml(ROOT/'assets/lane-result.yaml') or {}
    if 'evidence_recon' not in flat.get('decision_set',{}): finding('EGWD320-ASSET','flat evidence ref missing')
    if 'evidence_recon' not in graph.get('decision_graph',{}): finding('EGWD320-ASSET','graph evidence ref missing')
    lr=lane.get('lane_result',{}).get('evidence_recon',{}).get('lane_return',{})
    if lr.get('expedition_lane_version')!=1: finding('EGWD320-ASSET','lane v1 missing')
def check_python():
    for p in (ROOT/'scripts').glob('*.py'):
        try: py_compile.compile(str(p),doraise=True)
        except Exception as e: finding('EGWD320-COMPILE',f'{p.name}: {e}')
def check_symlinks():
    for p in ROOT.rglob('*'):
        if p.is_symlink(): finding('EGWD320-PACKAGE',f'symlink {p.relative_to(ROOT)}')
def main():
    check_required(); check_parse(); check_contract(); check_skill(); check_evals(); check_assets(); check_python(); check_symlinks()
    if F:
        print(f'{len(F)} finding(s):'); [print(' -',x) for x in F]; return 1
    print('EGWD320_PACKAGE_OK: Expanded Grill with Docs v3.2.0 evidence-recon integration validation passed')
    return 0
if __name__=='__main__': sys.exit(main())
