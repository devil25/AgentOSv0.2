"""Firefox Native Messaging host. stdout is reserved for framed protocol data."""
import sys, struct, json, traceback
from agentos.actions import handle
from agentos.audit import audit
MAX_MESSAGE=1024*1024

def read_message():
    raw=sys.stdin.buffer.read(4)
    if not raw: return None
    if len(raw)!=4: raise EOFError("Incomplete native message header")
    size=struct.unpack("<I",raw)[0]
    if size>MAX_MESSAGE: raise ValueError("Message too large")
    data=sys.stdin.buffer.read(size)
    if len(data)!=size: raise EOFError("Incomplete native message body")
    return json.loads(data.decode("utf-8"))

def send_message(obj):
    data=json.dumps(obj,ensure_ascii=False).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I",len(data))+data)
    sys.stdout.buffer.flush()

def main():
    while True:
        try:
            msg=read_message()
            if msg is None: break
            try: result=handle(msg)
            except Exception as e:
                audit("action.error",{"error":str(e)})
                result={"ok":False,"error":str(e)}
            send_message(result)
        except Exception as e:
            audit("host.error",{"error":str(e)})
            try: send_message({"ok":False,"error":str(e)})
            except Exception: break

if __name__=="__main__": main()
