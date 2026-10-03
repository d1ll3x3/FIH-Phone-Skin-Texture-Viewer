"""Convert a Unity charm AssetBundle to a portable FIH viewer document.

The input is read-only. Texture images are embedded so the result can be
imported through the browser's file picker without any texture sidecars.
"""

from __future__ import annotations

import argparse
import base64
from collections import Counter
import hashlib
import io
import json
from pathlib import Path
import struct
from typing import Any

import UnityPy
from UnityPy.classes.PPtr import PPtr
from UnityPy.helpers.MeshHelper import MeshHandler


def vector(value: Any, size: int = 3, reflect: bool = True) -> list[float]:
    keys = "xyzw"[:size]
    values = [float(value[key] if isinstance(value, dict) else getattr(value, key)) for key in keys]
    if reflect:
        if size == 4:
            values[0], values[1] = -values[0], -values[1]
        elif size == 3:
            values[2] = -values[2]
    return values


def reflected_rows(rows: Any) -> list[float]:
    return [n for row in rows or [] for n in (float(row[0]), float(row[1]), -float(row[2]))]


def matrix(value: dict[str, Any]) -> list[float]:
    if "c0" in value:
        values = [float(value[f"c{c}"]["xyzw"[r]]) for c in range(4) for r in range(4)]
    else:
        values = [float(value[f"e{r}{c}"]) for c in range(4) for r in range(4)]
    # Coordinate reflection is S * M * S, S = diag(1, 1, -1, 1).
    return [n * (-1 if (i % 4 == 2) != (i // 4 == 2) else 1) for i, n in enumerate(values)]


def multiply_matrices(left: list[float], right: list[float]) -> list[float]:
    return [sum(left[k * 4 + row] * right[column * 4 + k] for k in range(4)) for column in range(4) for row in range(4)]


def raw_array(value: Any, fmt: str, width: int = 1) -> list[Any]:
    if not value:
        return []
    if isinstance(value, dict):
        count = int(value.get("count", 0))
        data = bytes(value.get("arrayBytes", []))
    else:
        data = bytes(value)
        count = len(data) // struct.calcsize("<" + fmt) // width
    wanted = count * width
    size = struct.calcsize("<" + fmt)
    if len(data) < wanted * size:
        raise ValueError("Incomplete serialized MagicaCloth array")
    return list(struct.unpack_from("<" + str(wanted) + fmt, data)) if wanted else []


def reflect_flat(values: list[float]) -> list[float]:
    return [n if i % 3 != 2 else -n for i, n in enumerate(values)]


def reverse_winding(indices: list[int]) -> list[int]:
    if len(indices) % 3:
        raise ValueError("Triangle index count is not divisible by three")
    return [n for i in range(0, len(indices), 3) for n in (indices[i], indices[i + 2], indices[i + 1])]


class BundleConverter:
    def __init__(self, path: Path | str):
        self.path = Path(path)
        # Loading bytes releases the input handle immediately, including on Windows.
        self.bundle_bytes = self.path.read_bytes()
        self.environment = UnityPy.load(self.bundle_bytes)
        self.objects = list(self.environment.objects)
        self.trees: dict[int, dict[str, Any]] = {}
        self.warnings: list[str] = []
        self.nodes: list[dict[str, Any]] = []
        self.node_ids: dict[int, str] = {}
        self.materials: list[dict[str, Any]] = []
        self.material_ids: dict[int, int] = {}
        self.meshes: list[dict[str, Any]] = []
        self.mesh_sources: list[tuple[Any, Any]] = []

    def tree(self, obj: Any) -> dict[str, Any]:
        key = id(obj)
        if key not in self.trees:
            self.trees[key] = obj.parse_as_dict()
        return self.trees[key]

    def resolve(self, owner: Any, pointer: Any) -> Any:
        if not pointer or not pointer.get("m_PathID"):
            return None
        try:
            return PPtr(m_FileID=pointer["m_FileID"], m_PathID=pointer["m_PathID"], assetsfile=owner.assets_file).deref()
        except (KeyError, ValueError, FileNotFoundError) as error:
            self.warnings.append(f"Missing bundle reference {pointer}: {error}")
            return None

    def node_for_gameobject(self, owner: Any, pointer: Any) -> str | None:
        gameobject = self.resolve(owner, pointer)
        if gameobject:
            for component in self.tree(gameobject).get("m_Component", []):
                transform = self.resolve(gameobject, component["component"])
                if transform and transform.type.name in ("Transform", "RectTransform"):
                    return self.node_ids.get(id(transform))
        return None

    def extract_nodes(self) -> None:
        transforms = [obj for obj in self.objects if obj.type.name in ("Transform", "RectTransform")]
        for ordinal, obj in enumerate(transforms):
            self.node_ids[id(obj)] = f"node-{ordinal}-{obj.path_id}"
        for obj in transforms:
            tree = self.tree(obj)
            gameobject = self.resolve(obj, tree.get("m_GameObject"))
            parent = self.resolve(obj, tree.get("m_Father"))
            self.nodes.append({
                "id": self.node_ids[id(obj)],
                "parent": self.node_ids.get(id(parent)) if parent else None,
                "name": self.tree(gameobject).get("m_Name", "Transform") if gameobject else "Transform",
                "position": vector(tree["m_LocalPosition"]),
                "rotation": vector(tree["m_LocalRotation"], 4),
                "scale": vector(tree["m_LocalScale"], reflect=False),
            })

    def extract_material(self, obj: Any) -> int:
        if obj is None:
            key = 0
            data = {"name": "Default", "color": [1, 1, 1, 1], "metalness": 0, "roughness": 0.6}
        else:
            key = id(obj)
            if key in self.material_ids:
                return self.material_ids[key]
            tree = self.tree(obj)
            saved = tree.get("m_SavedProperties", {})
            floats = dict(saved.get("m_Floats", []))
            colors = dict(saved.get("m_Colors", []))
            textures = dict(saved.get("m_TexEnvs", []))
            color = colors.get("baseColorFactor", colors.get("_BaseColor", colors.get("_Color", {"r": 1, "g": 1, "b": 1, "a": 1})))
            data = {
                "name": tree.get("m_Name", "Material"),
                "color": [color.get(k, 1) for k in "rgba"],
                "metalness": floats.get("metallicFactor", floats.get("_Metallic", 0)),
                "roughness": floats.get("roughnessFactor", 1 - floats.get("_Glossiness", 0.4)),
                "doubleSided": floats.get("_Cull", floats.get("_CullMode", 2)) == 0,
            }
            texture_setting = next((textures[k] for k in ("baseColorTexture", "_BaseMap", "_MainTex") if k in textures and textures[k].get("m_Texture", {}).get("m_PathID")), None)
            if texture_setting:
                texture = self.resolve(obj, texture_setting["m_Texture"])
                if texture:
                    stream = io.BytesIO()
                    texture.parse_as_object().image.save(stream, format="PNG")
                    data["map"] = "data:image/png;base64," + base64.b64encode(stream.getvalue()).decode("ascii")
                    data["mapRepeat"] = vector(texture_setting.get("m_Scale", {"x": 1, "y": 1}), 2, False)
                    data["mapOffset"] = vector(texture_setting.get("m_Offset", {"x": 0, "y": 0}), 2, False)
        index = len(self.materials)
        self.materials.append(data)
        self.material_ids[key] = index
        return index

    def extract_meshes(self) -> None:
        filters: dict[int, tuple[Any, dict[str, Any]]] = {}
        for obj in self.objects:
            if obj.type.name == "MeshFilter":
                tree = self.tree(obj)
                go = self.resolve(obj, tree.get("m_GameObject"))
                if go:
                    filters[id(go)] = (obj, tree)
        for obj in self.objects:
            if obj.type.name not in ("MeshRenderer", "SkinnedMeshRenderer"):
                continue
            tree = self.tree(obj)
            if not tree.get("m_Enabled", True):
                continue
            owner = obj
            if obj.type.name == "SkinnedMeshRenderer":
                mesh_pointer = tree.get("m_Mesh")
            else:
                go = self.resolve(obj, tree.get("m_GameObject"))
                if not go or id(go) not in filters:
                    continue
                owner, filter_tree = filters[id(go)]
                mesh_pointer = filter_tree.get("m_Mesh")
            mesh_obj = self.resolve(owner, mesh_pointer)
            if not mesh_obj:
                continue
            mesh = mesh_obj.parse_as_object()
            handler = MeshHandler(mesh)
            handler.process()
            positions = reflected_rows(handler.m_Vertices)
            if not positions:
                continue
            groups = []
            indices = []
            for material_index, triangles in enumerate(handler.get_triangles()):
                subset = reverse_winding([n for triangle in triangles for n in triangle])
                groups.append({"start": len(indices), "count": len(subset), "materialIndex": material_index})
                indices.extend(subset)
            result = {
                "name": mesh.m_Name,
                "node": self.node_for_gameobject(obj, tree.get("m_GameObject")),
                "positions": positions,
                "normals": reflected_rows(handler.m_Normals),
                "uvs": [float(n) for uv in handler.m_UV0 or [] for n in uv[:2]],
                "indices": indices,
                "groups": groups,
                "materials": [self.extract_material(self.resolve(obj, ref)) for ref in tree.get("m_Materials", [])],
            }
            if not result["materials"]:
                result["materials"] = [self.extract_material(None)]
            if obj.type.name == "SkinnedMeshRenderer":
                bones = [self.resolve(obj, ref) for ref in tree.get("m_Bones", [])]
                result["bones"] = [self.node_ids.get(id(bone)) for bone in bones]
                result["skinIndices"] = [int(n) for row in handler.m_BoneIndices or [] for n in row]
                result["skinWeights"] = [float(n) for row in handler.m_BoneWeights or [] for n in row]
                result["bindPoses"] = [matrix(pose) for pose in self.tree(mesh_obj).get("m_BindPose", [])]
                if not result["skinIndices"] or any(bone is None for bone in result["bones"]):
                    self.warnings.append(f"Incomplete rig references for {mesh.m_Name}")
            self.mesh_sources.append((obj, mesh_obj))
            self.meshes.append(result)
        if not self.meshes:
            raise ValueError("The bundle has no supported, enabled mesh renderer")

    def extract_physics(self) -> dict[str, Any]:
        prebuilds = []
        for obj in self.objects:
            if obj.type.name != "MonoBehaviour":
                continue
            try:
                tree = self.tree(obj)
            except (ValueError, TypeError, KeyError):
                self.warnings.append(f"MonoBehaviour {obj.path_id} has no readable type tree")
                continue
            script = self.resolve(obj, tree.get("m_Script"))
            script_tree = self.tree(script) if script else {}
            if script_tree.get("m_Namespace") == "MagicaCloth2" and script_tree.get("m_ClassName") == "PreBuildScriptableObject":
                for data in tree.get("sharePreBuildDataList", []):
                    prebuilds.append((obj, data))
        for mesh_index, (_, mesh_obj) in enumerate(self.mesh_sources):
            for owner, data in prebuilds:
                for setup_index, setup in enumerate(data.get("renderSetupDataList", [])):
                    source = self.resolve(owner, setup.get("originalMesh"))
                    proxy = data.get("proxyMesh", {})
                    if source is not mesh_obj or not proxy.get("localPositions", {}).get("count"):
                        continue
                    positions = reflect_flat(raw_array(proxy["localPositions"], "f", 3))
                    attributes = raw_array(proxy.get("attributes"), "B")
                    fixed = [i for i, flags in enumerate(attributes) if flags & 1]
                    links = []
                    seen = set()
                    constraint = data.get("distanceConstraintData", {})
                    for i, encoded in enumerate(constraint.get("indexArray", [])):
                        count, start = encoded >> 20, encoded & 0xFFFFF
                        for offset in range(start, start + count):
                            j = constraint["dataArray"][offset]
                            pair = tuple(sorted((i, j)))
                            if pair in seen:
                                continue
                            seen.add(pair)
                            length = constraint["distanceArray"][offset]
                            links.append([i, j, abs(float(length)), 1 if length < 0 else 0])
                    render = data["renderMeshList"][setup_index]
                    mapping_bytes = bytes(render["boneWeights"]["arrayBytes"])
                    count = render["boneWeights"]["count"]
                    render_attributes = raw_array(render.get("attributes"), "B")
                    references = raw_array(render.get("referenceIndices"), "i") or list(range(count))
                    if sorted(references) != list(range(count)) or (render_attributes and len(render_attributes) != count):
                        raise ValueError("MagicaCloth render attributes do not match mesh vertices")
                    weights = [0.0] * (count * 4)
                    mapping = [0] * (count * 4)
                    for i, vertex in enumerate(references):
                        weights[vertex * 4:vertex * 4 + 4] = struct.unpack_from("<4f", mapping_bytes, i * 32)
                        mapping[vertex * 4:vertex * 4 + 4] = struct.unpack_from("<4i", mapping_bytes, i * 32 + 16)
                    render_fixed = sorted(references[i] for i, flags in enumerate(render_attributes) if flags & 1)
                    if count != len(self.meshes[mesh_index]["positions"]) // 3:
                        raise ValueError("MagicaCloth render mapping does not match mesh vertices")
                    if any(index < 0 or index >= len(positions) // 3 for index in mapping):
                        raise ValueError("MagicaCloth render mapping has invalid proxy indices")
                    rotations = raw_array(proxy.get("vertexBindPoseRotations"), "f", 4)
                    rotations = [n * (-1 if i % 4 in (0, 1) else 1) for i, n in enumerate(rotations)]
                    bending = dict(data.get("bendingConstraintData", {}))
                    # Decode packed uint64s before JavaScript loses their low bits.
                    bending["pairs"] = [[(packed >> shift) & 0xFFFF for shift in (0, 16, 32, 48)] for packed in bending.pop("trianglePairArray", [])]
                    self.warnings.append("The bundle contains MagicaCloth2 prebuild geometry, but no runtime cloth parameters. Browser stiffness, damping and collisions approximate the game.")
                    return {
                        "type": "mesh",
                        "source": "MagicaCloth2.PreBuildScriptableObject",
                        "sourceVersion": data.get("version"),
                        "buildId": data.get("buildId"),
                        "node": self.meshes[mesh_index]["node"],
                        "proxyToNodeMatrix": multiply_matrices(matrix(render["initWorldToLocal"]), matrix(proxy["initLocalToWorld"])),
                        "positions": positions,
                        "normals": reflect_flat(raw_array(proxy.get("localNormals"), "f", 3)),
                        "fixed": fixed,
                        "attributes": attributes,
                        "links": links,
                        "triangles": reverse_winding(raw_array(proxy.get("triangles"), "i", 3)),
                        "lines": raw_array(proxy.get("lines"), "i", 2),
                        "parentIndices": raw_array(proxy.get("vertexParentIndices"), "i"),
                        "rootIndices": raw_array(proxy.get("vertexRootIndices"), "i"),
                        "depths": raw_array(proxy.get("vertexDepths"), "f"),
                        "restRotations": rotations,
                        "attachment": vector(proxy.get("localCenterPosition", {"x": 0, "y": 0, "z": 0})),
                        "centerFixed": proxy.get("centerFixedList", []),
                        "gravityDirection": vector(data.get("inertiaConstraintData", {}).get("initLocalGravityDirection", {"x": 0, "y": -1, "z": 0})),
                        "renderMappings": [{"mesh": mesh_index, "indices": mapping, "weights": weights,
                                            "fixed": render_fixed, "toProxyMatrix": matrix(render["toProxyMatrix"])}],
                        "parameters": {"runtimeAvailable": False},
                        "bending": bending,
                    }
        rig_roots = set()
        node_by_id = {node["id"]: node for node in self.nodes}
        for mesh in self.meshes:
            bones = set(mesh.get("bones", [])) - {None}
            rig_roots.update(bone for bone in bones if node_by_id[bone]["parent"] not in bones)
        if rig_roots:
            self.warnings.append("No supported MagicaCloth2 prebuild found. Bone physics uses viewer defaults.")
            return {"type": "bones", "roots": sorted(rig_roots), "fixed": sorted(rig_roots), "parameters": {"runtimeAvailable": False}}
        self.warnings.append("No supported cloth or rig data found. The viewer uses a rigid pendant approximation.")
        return {"type": "pendant", "parameters": {"runtimeAvailable": False}}

    def convert(self) -> dict[str, Any]:
        self.extract_nodes()
        self.extract_meshes()
        physics = self.extract_physics()
        result = {
            "format": "fih-charm",
            "version": 1,
            "name": self.path.stem,
            "coordinateSystem": "right-handed-y-up",
            "nodes": self.nodes,
            "meshes": self.meshes,
            "materials": self.materials,
            "physics": physics,
            "source": {"bundle": self.path.name, "sha256": hashlib.sha256(self.bundle_bytes).hexdigest(), "unityVersion": self.objects[0].assets_file.unity_version if self.objects else None},
            "warnings": list(dict.fromkeys(self.warnings)),
        }
        # JSON has no NaN/Infinity; fail here before a malformed asset reaches the viewer.
        json.dumps(result, allow_nan=False)
        return result

    def report(self) -> dict[str, Any]:
        return {
            "bundle": str(self.path),
            "types": dict(Counter(obj.type.name for obj in self.objects)),
            "containers": list(self.environment.container),
            "objects": [{"pathId": str(obj.path_id), "type": obj.type.name, "tree": self.tree(obj)} for obj in self.objects if obj.type.name in ("MonoBehaviour", "MonoScript", "Transform", "MeshFilter", "MeshRenderer", "SkinnedMeshRenderer", "GameObject", "Material")],
        }


def convert_bundle(path: Path | str) -> dict[str, Any]:
    """Read a Unity AssetBundle and return a JSON-serializable charm document."""
    return BundleConverter(path).convert()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("bundle", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--report", type=Path, help="Optional full serialized metadata report")
    parser.add_argument("--script", type=Path, help="Optional browser sample wrapper (window.FIH_HAT_CHARM)")
    args = parser.parse_args()
    converter = BundleConverter(args.bundle)
    result = converter.convert()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    encoded = json.dumps(result, separators=(",", ":"), allow_nan=False)
    args.output.write_text(encoded, encoding="utf-8")
    if args.script:
        args.script.parent.mkdir(parents=True, exist_ok=True)
        args.script.write_text("window.FIH_HAT_CHARM = " + encoded + ";\n", encoding="utf-8")
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(converter.report(), indent=2), encoding="utf-8")
    vertices = sum(len(mesh["positions"]) // 3 for mesh in result["meshes"])
    print(f"Exported {args.output}: {len(result['meshes'])} meshes, {vertices} vertices, physics={result['physics']['type']}")
    for warning in result["warnings"]:
        print("Warning:", warning)


if __name__ == "__main__":
    main()
