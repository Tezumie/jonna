//! The MCP request handler: lists tools/resources from the catalog and forwards calls/reads.

use std::sync::{Arc, RwLock};

use rmcp::model::{
    CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, Implementation,
    ListResourcesResult, ListToolsResult, PaginatedRequestParams, ReadResourceRequestParams,
    ReadResourceResponse, ReadResourceResult, Resource, ResourceContents, ServerCapabilities,
    ServerConfig, Tool,
};
use rmcp::service::RequestContext;
use rmcp::{ErrorData as McpError, RoleServer, ServerHandler};
use serde_json::{json, Map, Value};

use super::{tool_name, Bridge, BridgeRequest, Catalog, ToolSpec};

const FIND: &str = "ide_find_commands";
const RUN: &str = "ide_run_command";

const INSTRUCTIONS: &str =
    "Tools are the IDE's commands (the same ones its UI uses). Core tools are \
listed; find more with ide_find_commands and run them with ide_run_command. Read ide:// resources \
for state (ide://workspace, ide://editors/active, ide://diagnostics, ide://terminals, \
ide://layout…). Paths may be relative to the workspace root. Commands that change things may ask \
the user first.";

#[derive(Clone)]
pub struct IdeServer {
    pub catalog: Arc<RwLock<Catalog>>,
    pub bridge: Arc<Bridge>,
}

fn object(schema: Value) -> Arc<Map<String, Value>> {
    match schema {
        Value::Object(map) => Arc::new(map),
        _ => Arc::new(Map::from_iter([("type".to_string(), json!("object"))])),
    }
}

fn tool_for(spec: &ToolSpec) -> Tool {
    Tool::new(
        tool_name(&spec.command),
        format!("{}. {}", spec.title, spec.description),
        object(spec.input_schema.clone()),
    )
}

fn client_name(context: &RequestContext<RoleServer>) -> String {
    context
        .peer
        .peer_info()
        .map(|info| info.client_info.name.clone())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "MCP client".into())
}

fn text_result(value: &Value, is_error: bool) -> CallToolResponse {
    let text = match value {
        Value::String(s) => s.clone(),
        Value::Null => "done".into(),
        other => serde_json::to_string_pretty(other).unwrap_or_default(),
    };
    let content = vec![ContentBlock::text(text)];
    if is_error {
        CallToolResult::error(content).into()
    } else {
        CallToolResult::success(content).into()
    }
}

impl IdeServer {
    fn tools(&self) -> Vec<ToolSpec> {
        self.catalog
            .read()
            .map(|c| c.tools.clone())
            .unwrap_or_default()
    }

    async fn run(&self, client: String, command: String, input: Value) -> CallToolResponse {
        let id = self.bridge.next_id();
        let request = BridgeRequest::Call {
            id,
            client,
            command,
            input,
        };
        match self.bridge.ask(id, request).await {
            Ok(value) => text_result(&value, false),
            Err(message) => text_result(&Value::String(message), true),
        }
    }

    fn find(&self, query: &str) -> Value {
        let q = query.to_lowercase();
        let words: Vec<&str> = q.split_whitespace().collect();
        let hits: Vec<Value> = self
            .tools()
            .into_iter()
            .filter(|t| {
                let hay = format!("{} {} {}", t.command, t.title, t.description).to_lowercase();
                words.iter().all(|w| hay.contains(w))
            })
            .take(30)
            .map(|t| {
                json!({ "command": t.command, "title": t.title, "description": t.description,
                        "inputSchema": t.input_schema, "readOnly": t.read_only })
            })
            .collect();
        json!({ "commands": hits, "note": "Run one with ide_run_command { command, input }." })
    }
}

impl ServerHandler for IdeServer {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(
            ServerCapabilities::builder()
                .enable_tools()
                .enable_resources()
                .build(),
        )
        .with_server_info(Implementation::new(
            crate::product_term_program(),
            env!("CARGO_PKG_VERSION"),
        ))
        .with_instructions(INSTRUCTIONS)
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, McpError> {
        let mut tools: Vec<Tool> = self
            .tools()
            .iter()
            .filter(|t| t.core)
            .map(tool_for)
            .collect();
        tools.push(Tool::new(
            FIND,
            "Search the IDE's commands (beyond the listed tools) by words in their id, title or description. Returns ids, descriptions and input schemas.",
            object(json!({ "type": "object", "properties": { "query": { "type": "string" } }, "required": ["query"] })),
        ));
        tools.push(Tool::new(
            RUN,
            "Run any IDE command by id (see ide_find_commands) with its input object.",
            object(json!({ "type": "object", "properties": {
                "command": { "type": "string" }, "input": { "type": "object" } }, "required": ["command"] })),
        ));
        Ok(ListToolsResult::with_all_items(tools))
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, McpError> {
        let args = Value::Object(request.arguments.clone().unwrap_or_default());
        let client = client_name(&context);
        let name = request.name.as_ref();
        if name == FIND {
            let query = args
                .get("query")
                .and_then(Value::as_str)
                .unwrap_or_default();
            return Ok(text_result(&self.find(query), false));
        }
        if name == RUN {
            let command = args
                .get("command")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if !self.tools().iter().any(|t| t.command == command) {
                return Ok(text_result(
                    &json!(format!(
                        "Unknown command \"{command}\"; use ide_find_commands."
                    )),
                    true,
                ));
            }
            let input = args.get("input").cloned().unwrap_or_else(|| json!({}));
            return Ok(self.run(client, command.to_string(), input).await);
        }
        match self
            .tools()
            .into_iter()
            .find(|t| tool_name(&t.command) == name)
        {
            Some(tool) => Ok(self.run(client, tool.command, args).await),
            None => Err(McpError::invalid_params(
                format!("unknown tool {name}"),
                None,
            )),
        }
    }

    async fn list_resources(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListResourcesResult, McpError> {
        let resources = self
            .catalog
            .read()
            .map(|c| c.resources.clone())
            .unwrap_or_default()
            .into_iter()
            .map(|r| {
                Resource::new(r.uri.clone(), r.uri)
                    .with_description(r.description)
                    .with_mime_type("application/json")
            })
            .collect();
        Ok(ListResourcesResult::with_all_items(resources))
    }

    async fn read_resource(
        &self,
        request: ReadResourceRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<ReadResourceResponse, McpError> {
        let uri = request.uri.clone();
        let id = self.bridge.next_id();
        let ask = BridgeRequest::Read {
            id,
            client: client_name(&context),
            uri: uri.clone(),
        };
        match self.bridge.ask(id, ask).await {
            Ok(value) => {
                let text = serde_json::to_string_pretty(&value).unwrap_or_default();
                let contents = ResourceContents::text(text, uri).with_mime_type("application/json");
                Ok(ReadResourceResult::new(vec![contents]).into())
            }
            Err(message) => Err(McpError::resource_not_found(message, None)),
        }
    }
}
