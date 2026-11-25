"""Tiny demo MCP server using the official MCP Python SDK v2.
Install with: python -m pip install "mcp[cli]>=2.0.0"
"""
from mcp.server import MCPServer

mcp = MCPServer("AgentOS Demo MCP")

@mcp.tool()
def echo(text: str) -> str:
    """Return the supplied text. Safe demonstration tool."""
    return text

@mcp.tool()
def add(a: int, b: int) -> int:
    """Add two integers."""
    return a + b

if __name__ == "__main__":
    mcp.run()
