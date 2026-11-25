import sys, unittest, tempfile
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from agentos.actions import execute

class ActionTests(unittest.TestCase):
    def test_status(self): self.assertTrue(execute("runtime.status",{})["ok"])
    def test_unsupported(self):
        with self.assertRaises(ValueError): execute("terminal.execute",{"command":"whoami"})
    def test_path_traversal_rejected(self):
        with self.assertRaises(ValueError): execute("workspace.read_file",{"path":"../../Windows/win.ini"})

if __name__=="__main__": unittest.main()
