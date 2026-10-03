"""Regression checks for the sample bundle's exported geometry and cloth data."""

import base64
import io
import json
import math
from pathlib import Path
import struct
import unittest

from PIL import Image

from convert_charm import matrix, multiply_matrices, raw_array, vector


IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]


class CoordinateTests(unittest.TestCase):
    def test_unity_reflection_preserves_scale_and_changes_translation(self):
        unity = {f"e{r}{c}": IDENTITY[c * 4 + r] for c in range(4) for r in range(4)}
        unity.update(e03=2, e13=3, e23=4)
        self.assertEqual(matrix(unity)[12:15], [2, 3, -4])
        self.assertEqual(vector({"x": 2, "y": 3, "z": 4}, reflect=False), [2, 3, 4])

    def test_column_major_composition(self):
        translated = IDENTITY.copy()
        translated[12:15] = [2, 3, 4]
        scaled = IDENTITY.copy()
        scaled[0], scaled[5], scaled[10] = 2, 3, 4
        self.assertEqual(multiply_matrices(scaled, translated)[12:15], [4, 9, 16])

    def test_buffer_uses_count_not_capacity(self):
        packed = {"count": 1, "length": 2, "arrayBytes": list(struct.pack("<6f", 1, 2, 3, 7, 8, 9))}
        self.assertEqual(raw_array(packed, "f", 3), [1, 2, 3])
        with self.assertRaises(ValueError):
            raw_array({"count": 2, "arrayBytes": [0, 0]}, "f", 3)


class SampleTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        path = Path(__file__).resolve().parents[1] / "assets" / "charms" / "hat.json"
        cls.charm = json.loads(path.read_text(encoding="utf-8"))

    def test_sample_has_its_original_render_mesh_and_texture(self):
        charm = self.charm
        self.assertEqual((charm["format"], charm["version"]), ("fih-charm", 1))
        self.assertEqual(len(charm["nodes"]), 1)
        mesh = charm["meshes"][0]
        self.assertEqual(len(mesh["positions"]) // 3, 451)
        self.assertEqual(len(mesh["indices"]) // 3, 506)
        self.assertTrue(all(0 <= index < 451 for index in mesh["indices"]))
        encoded = charm["materials"][0]["map"].split(",", 1)[1]
        with Image.open(io.BytesIO(base64.b64decode(encoded))) as image:
            self.assertGreaterEqual(min(image.size), 64)
            self.assertGreater(len(image.getcolors(maxcolors=2**24)), 10)

    def test_prebuild_pins_and_link_rest_lengths_match_geometry(self):
        physics = self.charm["physics"]
        self.assertEqual(physics["type"], "mesh")
        self.assertEqual(physics["fixed"], [7, 8, 9, 10])
        self.assertEqual(len(physics["positions"]) // 3, 60)
        self.assertEqual(len(physics["depths"]), 60)
        self.assertTrue(all(0 <= depth <= 1 for depth in physics["depths"]))
        self.assertEqual(len(physics["rootIndices"]), 60)
        self.assertTrue(all(root == -1 or root in physics["fixed"] for root in physics["rootIndices"]))
        self.assertEqual(len(physics["links"]), 165)
        self.assertEqual(physics["proxyToNodeMatrix"], IDENTITY)
        points = [physics["positions"][i:i + 3] for i in range(0, len(physics["positions"]), 3)]
        for a, b, distance, _ in physics["links"]:
            self.assertAlmostEqual(math.dist(points[a], points[b]), distance, places=6)
        roots = [i for i, parent in enumerate(physics["parentIndices"]) if parent == -1]
        self.assertEqual(roots, physics["fixed"])

    def test_bending_pairs_preserve_shared_edge_and_opposite_vertices(self):
        physics = self.charm["physics"]
        triangles = {frozenset(physics["triangles"][i:i + 3]) for i in range(0, len(physics["triangles"]), 3)}
        self.assertEqual(len(physics["bending"]["pairs"]), 197)
        self.assertNotIn("trianglePairArray", physics["bending"])
        for a, b, c, d in physics["bending"]["pairs"]:
            self.assertIn(frozenset((a, b, c)), triangles)
            self.assertIn(frozenset((a, b, d)), triangles)

    def test_render_mapping_is_normalized_and_references_proxy(self):
        mapping = self.charm["physics"]["renderMappings"][0]
        self.assertEqual(len(mapping["indices"]), 451 * 4)
        self.assertEqual(len(mapping["weights"]), 451 * 4)
        self.assertTrue(all(0 <= index < 60 for index in mapping["indices"]))
        for i in range(0, len(mapping["weights"]), 4):
            self.assertAlmostEqual(sum(mapping["weights"][i:i + 4]), 1, places=6)
        self.assertFalse(self.charm["physics"]["parameters"]["runtimeAvailable"])

    def test_original_render_fixed_selection_is_exported(self):
        fixed = self.charm["physics"]["renderMappings"][0]["fixed"]
        expected = [34, 38, 39, *range(43, 79), 80, 81, 82, 85, 86, 87]
        self.assertEqual(fixed, expected)
        self.assertEqual(len(fixed), 45)


if __name__ == "__main__":
    unittest.main()
