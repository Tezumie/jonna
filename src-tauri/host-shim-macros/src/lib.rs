//! The windowless host's stand-ins for the desktop framework's two macros.
//!
//! `#[command]` leaves the function as written and adds an adapter beside it,
//! `__host_cmd__<name>`, that the host's server calls with one invocation (JSON params, an
//! optional raw body and headers, the connection). Each parameter is taken through
//! `host_shim::host::CommandArg` (the managed state, a channel, the handle, the raw request, or a
//! value deserialized from `params[<camelCase name>]`), the same split the framework makes.
//!
//! `generate_handler![a::b::name, …]` builds the table of those adapters.

use heck::ToLowerCamelCase;
use proc_macro::TokenStream;
use proc_macro2::{Span, TokenStream as TokenStream2};
use quote::{format_ident, quote};
use syn::parse::{Parse, ParseStream};
use syn::punctuated::Punctuated;
use syn::{parse_macro_input, FnArg, ItemFn, LitStr, Pat, Path, ReturnType, Token, Type};

/// How argument names are written on the wire.
enum Rename {
    Camel,
    Snake,
}

struct CommandOptions {
    rename: Rename,
}

impl Parse for CommandOptions {
    fn parse(input: ParseStream) -> syn::Result<Self> {
        let mut rename = Rename::Camel;
        while !input.is_empty() {
            let name: syn::Ident = input.parse()?;
            if name == "rename_all" {
                input.parse::<Token![=]>()?;
                let value: LitStr = input.parse()?;
                rename = match value.value().as_str() {
                    "snake_case" => Rename::Snake,
                    "camelCase" => Rename::Camel,
                    other => {
                        return Err(syn::Error::new(
                            value.span(),
                            format!("unsupported rename_all: {other}"),
                        ))
                    }
                };
            } else if name == "async" {
                // The framework's "run this sync command on the async runtime": the host runs
                // sync commands off the runtime's threads either way.
            } else {
                return Err(syn::Error::new(
                    name.span(),
                    format!("unsupported command option: {name}"),
                ));
            }
            if input.is_empty() {
                break;
            }
            input.parse::<Token![,]>()?;
        }
        Ok(Self { rename })
    }
}

/// True when the return type is written as a `Result` (the crate's alias or std's): its `Err`
/// becomes the command's error, as the framework does.
fn returns_result(output: &ReturnType) -> bool {
    let ReturnType::Type(_, ty) = output else {
        return false;
    };
    let Type::Path(path) = ty.as_ref() else {
        return false;
    };
    path.path
        .segments
        .last()
        .is_some_and(|segment| segment.ident == "Result")
}

fn expand_command(options: CommandOptions, function: ItemFn) -> syn::Result<TokenStream2> {
    let name = &function.sig.ident;
    let adapter = format_ident!("__host_cmd__{}", name);
    let mut bindings = Vec::new();
    let mut names = Vec::new();
    for (index, input) in function.sig.inputs.iter().enumerate() {
        let FnArg::Typed(arg) = input else {
            return Err(syn::Error::new_spanned(
                input,
                "a command can't take `self`",
            ));
        };
        let Pat::Ident(pat) = arg.pat.as_ref() else {
            return Err(syn::Error::new_spanned(
                &arg.pat,
                "a command's parameters must be plain names",
            ));
        };
        let raw = pat.ident.to_string();
        let raw = raw.strip_prefix("r#").unwrap_or(&raw).to_string();
        let key = match options.rename {
            Rename::Camel => raw.to_lower_camel_case(),
            Rename::Snake => raw,
        };
        let local = format_ident!("__arg{}", index);
        let ty = &arg.ty;
        bindings.push(quote! {
            let #local = match <#ty as ::host_shim::host::CommandArg>::from_invocation(&__inv, #key) {
                ::std::result::Result::Ok(value) => value,
                ::std::result::Result::Err(reply) => return reply,
            };
        });
        names.push(local);
    }
    let reply = if returns_result(&function.sig.output) {
        quote!(::host_shim::host::reply_result)
    } else {
        quote!(::host_shim::host::reply_value)
    };
    let body = if function.sig.asyncness.is_some() {
        quote! {
            ::std::boxed::Box::pin(async move {
                let __inv = __inv;
                #(#bindings)*
                #reply(#name(#(#names),*).await)
            })
        }
    } else {
        quote! {
            ::host_shim::host::run_blocking(move || {
                let __inv = __inv;
                #(#bindings)*
                #reply(#name(#(#names),*))
            })
        }
    };
    Ok(quote! {
        #function

        #[doc(hidden)]
        #[allow(non_snake_case)]
        pub(crate) fn #adapter(
            __inv: ::host_shim::host::Invocation,
        ) -> ::host_shim::host::CommandFuture {
            #body
        }
    })
}

/// Marks a function as a command the host answers. See the crate's description.
#[proc_macro_attribute]
pub fn command(attributes: TokenStream, item: TokenStream) -> TokenStream {
    let options = parse_macro_input!(attributes as CommandOptions);
    let function = parse_macro_input!(item as ItemFn);
    expand_command(options, function)
        .unwrap_or_else(syn::Error::into_compile_error)
        .into()
}

struct Handlers {
    paths: Punctuated<Path, Token![,]>,
}

impl Parse for Handlers {
    fn parse(input: ParseStream) -> syn::Result<Self> {
        Ok(Self {
            paths: Punctuated::parse_terminated(input)?,
        })
    }
}

/// The table of commands: `&'static [host_shim::host::CommandEntry]`, one per path, named by
/// the function's own name (the path's last segment), as the framework names them.
#[proc_macro]
pub fn generate_handler(input: TokenStream) -> TokenStream {
    let handlers = parse_macro_input!(input as Handlers);
    let mut entries = Vec::new();
    for path in handlers.paths {
        let Some(last) = path.segments.last() else {
            return syn::Error::new(Span::call_site(), "an empty command path")
                .into_compile_error()
                .into();
        };
        let name = last.ident.to_string();
        let mut adapter = path.clone();
        if let Some(segment) = adapter.segments.last_mut() {
            segment.ident = format_ident!("__host_cmd__{}", last.ident);
        }
        entries.push(quote! {
            ::host_shim::host::CommandEntry { name: #name, run: #adapter }
        });
    }
    quote!({
        const TABLE: &[::host_shim::host::CommandEntry] = &[#(#entries),*];
        TABLE
    })
    .into()
}
