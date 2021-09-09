import { ErrorHandlingOptions, ParserOptions } from './options'
import { NO, isArray, makeMap, extend } from '@vue/shared'
import {
  ErrorCodes,
  createCompilerError,
  defaultOnError,
  defaultOnWarn
} from './errors'
import {
  assert,
  advancePositionWithMutation,
  advancePositionWithClone,
  isCoreComponent,
  isBindKey
} from './utils'
import {
  Namespaces,
  AttributeNode,
  CommentNode,
  DirectiveNode,
  ElementNode,
  ElementTypes,
  ExpressionNode,
  NodeTypes,
  Position,
  RootNode,
  SourceLocation,
  TextNode,
  TemplateChildNode,
  InterpolationNode,
  createRoot,
  ConstantTypes
} from './ast'
import {
  checkCompatEnabled,
  CompilerCompatOptions,
  CompilerDeprecationTypes,
  isCompatEnabled,
  warnDeprecation
} from './compat/compatConfig'

type OptionalOptions =
  | 'whitespace'
  | 'isNativeTag'
  | 'isBuiltInComponent'
  | keyof CompilerCompatOptions
type MergedParserOptions = Omit<Required<ParserOptions>, OptionalOptions> &
  Pick<ParserOptions, OptionalOptions>
type AttributeValue =
  | {
      content: string
      isQuoted: boolean
      loc: SourceLocation
    }
  | undefined

// The default decoder only provides escapes for characters reserved as part of
// the template syntax, and is only used if the custom renderer did not provide
// a platform-specific decoder.
const decodeRE = /&(gt|lt|amp|apos|quot);/g
const decodeMap: Record<string, string> = {
  gt: '>',
  lt: '<',
  amp: '&',
  apos: "'",
  quot: '"'
}

export const defaultParserOptions: MergedParserOptions = {
  delimiters: [`{{`, `}}`],
  getNamespace: () => Namespaces.HTML,
  getTextMode: () => TextModes.DATA,
  isVoidTag: NO,
  isPreTag: NO,
  isCustomElement: NO,
  decodeEntities: (rawText: string): string =>
    rawText.replace(decodeRE, (_, p1) => decodeMap[p1]),
  onError: defaultOnError,
  onWarn: defaultOnWarn,
  comments: __DEV__
}

export const enum TextModes {
  //          | Elements | Entities | End sign              | Inside of
  DATA, //    | ✔        | ✔        | End tags of ancestors |
  RCDATA, //  | ✘        | ✔        | End tag of the parent | <textarea>
  RAWTEXT, // | ✘        | ✘        | End tag of the parent | <style>,<script>
  CDATA,
  ATTRIBUTE_VALUE
}

export interface ParserContext {
  options: MergedParserOptions
  readonly originalSource: string
  source: string
  offset: number
  line: number
  column: number
  inPre: boolean // HTML <pre> tag, preserve whitespaces
  inVPre: boolean // v-pre, do not process directives and interpolations
  onWarn: NonNullable<ErrorHandlingOptions['onWarn']>
}

// 模板解析函数
export function baseParse(
  content: string,
  options: ParserOptions = {}
): RootNode {
  // 创建解析上下文，包括当前解析的一些信息
  const context = createParserContext(content, options)

  // 获取当前的解析指针
  const start = getCursor(context)

  // 用根节点承载它们
  return createRoot(
    // 将当前模板解析为AST节点
    parseChildren(context, TextModes.DATA, []),

    // 当前模板解析的范围(即模板本身)
    getSelection(context, start)
  )
}

function createParserContext(
  content: string,
  rawOptions: ParserOptions
): ParserContext {
  const options = extend({}, defaultParserOptions)

  let key: keyof ParserOptions
  for (key in rawOptions) {
    // @ts-ignore
    options[key] =
      rawOptions[key] === undefined
        ? defaultParserOptions[key]
        : rawOptions[key]
  }
  return {
    options,
    column: 1,
    line: 1,
    offset: 0,
    originalSource: content,
    source: content,
    inPre: false,
    inVPre: false,
    onWarn: options.onWarn
  }
}

function parseChildren(
  context: ParserContext, // 解析上下文
  mode: TextModes, // 解析模式
  ancestors: ElementNode[] // 解析栈
): TemplateChildNode[] {
  // 获取父节点
  const parent = last(ancestors)

  // 获取其命名空间
  const ns = parent ? parent.ns : Namespaces.HTML
  const nodes: TemplateChildNode[] = []

  // 循环解析，直到即将产生闭合元素或模板解析完毕
  while (!isEnd(context, mode, ancestors)) {
    __TEST__ && assert(context.source.length > 0)
    const s = context.source
    let node: TemplateChildNode | TemplateChildNode[] | undefined = undefined

    if (mode === TextModes.DATA || mode === TextModes.RCDATA) {
      // 不再v-pre上下文且检测到插值表达式的开启标签{{
      if (!context.inVPre && startsWith(s, context.options.delimiters[0])) {
        // '{{'
        // 解析插值表达式，返回ast节点
        node = parseInterpolation(context, mode)

        // 开始标签
      } else if (mode === TextModes.DATA && s[0] === '<') {
        // https://html.spec.whatwg.org/multipage/parsing.html#tag-open-state
        // 整个模板仅剩单个<报错
        if (s.length === 1) {
          emitError(context, ErrorCodes.EOF_BEFORE_TAG_NAME, 1)

          // 注释标签
        } else if (s[1] === '!') {
          // https://html.spec.whatwg.org/multipage/parsing.html#markup-declaration-open-state
          if (startsWith(s, '<!--')) {
            node = parseComment(context)
          } else if (startsWith(s, '<!DOCTYPE')) {
            // Ignore DOCTYPE by a limitation.
            node = parseBogusComment(context)
          } else if (startsWith(s, '<![CDATA[')) {
            if (ns !== Namespaces.HTML) {
              node = parseCDATA(context, ancestors)
            } else {
              emitError(context, ErrorCodes.CDATA_IN_HTML_CONTENT)
              node = parseBogusComment(context)
            }
          } else {
            emitError(context, ErrorCodes.INCORRECTLY_OPENED_COMMENT)
            node = parseBogusComment(context)
          }

          // 闭合标签
        } else if (s[1] === '/') {
          // https://html.spec.whatwg.org/multipage/parsing.html#end-tag-open-state
          if (s.length === 2) {
            emitError(context, ErrorCodes.EOF_BEFORE_TAG_NAME, 2)

            // 无结束标签报错并跳过
          } else if (s[2] === '>') {
            emitError(context, ErrorCodes.MISSING_END_TAG_NAME, 2)
            advanceBy(context, 3)
            continue

            // 检查到闭合标签名
          } else if (/[a-z]/i.test(s[2])) {
            emitError(context, ErrorCodes.X_INVALID_END_TAG)

            // 解析结束标签
            parseTag(context, TagType.End, parent)
            continue
          } else {
            emitError(
              context,
              ErrorCodes.INVALID_FIRST_CHARACTER_OF_TAG_NAME,
              2
            )
            node = parseBogusComment(context)
          }

          // 标签名
        } else if (/[a-z]/i.test(s[1])) {
          // 解析元素
          node = parseElement(context, ancestors)

          // 2.x <template> with no directive compat
          if (
            __COMPAT__ &&
            isCompatEnabled(
              CompilerDeprecationTypes.COMPILER_NATIVE_TEMPLATE,
              context
            ) &&
            node &&
            node.tag === 'template' &&
            !node.props.some(
              p =>
                p.type === NodeTypes.DIRECTIVE &&
                isSpecialTemplateDirective(p.name)
            )
          ) {
            __DEV__ &&
              warnDeprecation(
                CompilerDeprecationTypes.COMPILER_NATIVE_TEMPLATE,
                context,
                node.loc
              )
            node = node.children
          }

          // 有问题的注释
        } else if (s[1] === '?') {
          emitError(
            context,
            ErrorCodes.UNEXPECTED_QUESTION_MARK_INSTEAD_OF_TAG_NAME,
            1
          )

          node = parseBogusComment(context)
        } else {
          emitError(context, ErrorCodes.INVALID_FIRST_CHARACTER_OF_TAG_NAME, 1)
        }
      }
    }

    // 最后如果未解析到任何标签，那从当前开始作为文本解析
    if (!node) {
      node = parseText(context, mode)
    }

    if (isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        pushNode(nodes, node[i])
      }
    } else {
      pushNode(nodes, node)
    }
  }

  // Whitespace handling strategy like v2
  // 移除无用空白节点
  let removedWhitespace = false

  // 否未处理文本或rc时，处理空格
  if (mode !== TextModes.RAWTEXT && mode !== TextModes.RCDATA) {
    const shouldCondense = context.options.whitespace !== 'preserve'
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]

      // 确认当前节点不在<pre>元素中且为文本节点
      if (!context.inPre && node.type === NodeTypes.TEXT) {
        // 无特殊空白符号
        if (!/[^\t\r\n\f ]/.test(node.content)) {
          const prev = nodes[i - 1]
          const next = nodes[i + 1]
          // Remove if:
          // - the whitespace is the first or last node, or:
          // - (condense mode) the whitespace is adjacent to a comment, or:
          // - (condense mode) the whitespace is between two elements AND contains newline
          // - 首尾节点为空格
          // - 压缩模式下，前节点为注释，或后节点为注释
          // - 压缩模式下，前后节点为元素节点且当前节点为换行符
          if (
            !prev ||
            !next ||
            (shouldCondense &&
              (prev.type === NodeTypes.COMMENT ||
                next.type === NodeTypes.COMMENT ||
                (prev.type === NodeTypes.ELEMENT &&
                  next.type === NodeTypes.ELEMENT &&
                  /[\r\n]/.test(node.content))))
          ) {
            removedWhitespace = true
            nodes[i] = null as any

            // 其余情况，空白被视为单个空格
          } else {
            // Otherwise, the whitespace is condensed into a single space
            node.content = ' '
          }
        } else if (shouldCondense) {
          // in condense mode, consecutive whitespaces in text are condensed
          // down to a single space.
          node.content = node.content.replace(/[\t\r\n\f ]+/g, ' ')
        }
      }
      // Remove comment nodes if desired by configuration.
      else if (node.type === NodeTypes.COMMENT && !context.options.comments) {
        removedWhitespace = true
        nodes[i] = null as any
      }
    }

    // 当前节点在<pre>上下文中
    if (context.inPre && parent && context.options.isPreTag(parent.tag)) {
      // remove leading newline per html spec
      // https://html.spec.whatwg.org/multipage/grouping-content.html#the-pre-element
      const first = nodes[0]

      // 移除当前文本节点的首换行符
      if (first && first.type === NodeTypes.TEXT) {
        first.content = first.content.replace(/^\r?\n/, '')
      }
    }
  }

  // 筛掉nullish节点
  return removedWhitespace ? nodes.filter(Boolean) : nodes
}

// 加入节点数组，且合并相邻的文本节点
function pushNode(nodes: TemplateChildNode[], node: TemplateChildNode): void {
  if (node.type === NodeTypes.TEXT) {
    const prev = last(nodes)
    // Merge if both this and the previous node are text and those are
    // consecutive. This happens for cases like "a < b".
    if (
      prev &&
      prev.type === NodeTypes.TEXT &&
      prev.loc.end.offset === node.loc.start.offset
    ) {
      prev.content += node.content
      prev.loc.end = node.loc.end
      prev.loc.source += node.loc.source
      return
    }
  }

  nodes.push(node)
}

function parseCDATA(
  context: ParserContext,
  ancestors: ElementNode[]
): TemplateChildNode[] {
  __TEST__ &&
    assert(last(ancestors) == null || last(ancestors)!.ns !== Namespaces.HTML)
  __TEST__ && assert(startsWith(context.source, '<![CDATA['))

  advanceBy(context, 9)
  const nodes = parseChildren(context, TextModes.CDATA, ancestors)
  if (context.source.length === 0) {
    emitError(context, ErrorCodes.EOF_IN_CDATA)
  } else {
    __TEST__ && assert(startsWith(context.source, ']]>'))
    advanceBy(context, 3)
  }

  return nodes
}

function parseComment(context: ParserContext): CommentNode {
  __TEST__ && assert(startsWith(context.source, '<!--'))

  const start = getCursor(context)
  let content: string

  // Regular comment.
  const match = /--(\!)?>/.exec(context.source)
  if (!match) {
    content = context.source.slice(4)
    advanceBy(context, context.source.length)
    emitError(context, ErrorCodes.EOF_IN_COMMENT)
  } else {
    if (match.index <= 3) {
      emitError(context, ErrorCodes.ABRUPT_CLOSING_OF_EMPTY_COMMENT)
    }
    if (match[1]) {
      emitError(context, ErrorCodes.INCORRECTLY_CLOSED_COMMENT)
    }
    content = context.source.slice(4, match.index)

    // Advancing with reporting nested comments.
    const s = context.source.slice(0, match.index)
    let prevIndex = 1,
      nestedIndex = 0
    while ((nestedIndex = s.indexOf('<!--', prevIndex)) !== -1) {
      advanceBy(context, nestedIndex - prevIndex + 1)
      if (nestedIndex + 4 < s.length) {
        emitError(context, ErrorCodes.NESTED_COMMENT)
      }
      prevIndex = nestedIndex + 1
    }
    advanceBy(context, match.index + match[0].length - prevIndex + 1)
  }

  return {
    type: NodeTypes.COMMENT,
    content,
    loc: getSelection(context, start)
  }
}

function parseBogusComment(context: ParserContext): CommentNode | undefined {
  __TEST__ && assert(/^<(?:[\!\?]|\/[^a-z>])/i.test(context.source))

  const start = getCursor(context)
  const contentStart = context.source[1] === '?' ? 1 : 2
  let content: string

  const closeIndex = context.source.indexOf('>')
  if (closeIndex === -1) {
    content = context.source.slice(contentStart)
    advanceBy(context, context.source.length)
  } else {
    content = context.source.slice(contentStart, closeIndex)
    advanceBy(context, closeIndex + 1)
  }

  return {
    type: NodeTypes.COMMENT,
    content,
    loc: getSelection(context, start)
  }
}

function parseElement(
  context: ParserContext,
  ancestors: ElementNode[]
): ElementNode | undefined {
  __TEST__ && assert(/^<[a-z]/i.test(context.source))

  // Start tag.
  // 当前标签是否在<pre>标签中
  const wasInPre = context.inPre

  // 当前是否处于v-pre中
  const wasInVPre = context.inVPre

  // 获取父级标签ast节点
  const parent = last(ancestors)

  // 解析当前标签
  const element = parseTag(context, TagType.Start, parent)

  // 当前为<pre>标签
  const isPreBoundary = context.inPre && !wasInPre

  // 当前标签具有v-pre属性
  const isVPreBoundary = context.inVPre && !wasInVPre

  // 当前元素为自闭或空元素，则直接返回
  if (element.isSelfClosing || context.options.isVoidTag(element.tag)) {
    // #4030 self-closing <pre> tag
    if (isPreBoundary) {
      context.inPre = false
    }
    if (isVPreBoundary) {
      context.inVPre = false
    }
    return element
  }

  // Children.
  // 将当前元素加入栈中
  ancestors.push(element)

  // 获取当前元素文本模式
  const mode = context.options.getTextMode(element, parent)

  // 递归解析子元素并返回
  const children = parseChildren(context, mode, ancestors)

  // 解析完子元素，弹出当前元素，正常情况下来说，接下就是其尾标签
  ancestors.pop()

  // 2.x inline-template compat
  if (__COMPAT__) {
    const inlineTemplateProp = element.props.find(
      p => p.type === NodeTypes.ATTRIBUTE && p.name === 'inline-template'
    ) as AttributeNode
    if (
      inlineTemplateProp &&
      checkCompatEnabled(
        CompilerDeprecationTypes.COMPILER_INLINE_TEMPLATE,
        context,
        inlineTemplateProp.loc
      )
    ) {
      const loc = getSelection(context, element.loc.end)
      inlineTemplateProp.value = {
        type: NodeTypes.TEXT,
        content: loc.source,
        loc
      }
    }
  }

  element.children = children

  // End tag.
  // 解析尾标签
  if (startsWithEndTagOpen(context.source, element.tag)) {
    parseTag(context, TagType.End, parent)

    // 没匹配上且不为自闭和或空白标签则报错确实尾标签
  } else {
    emitError(context, ErrorCodes.X_MISSING_END_TAG, 0, element.loc.start)
    if (context.source.length === 0 && element.tag.toLowerCase() === 'script') {
      const first = children[0]
      if (first && startsWith(first.loc.source, '<!--')) {
        emitError(context, ErrorCodes.EOF_IN_SCRIPT_HTML_COMMENT_LIKE_TEXT)
      }
    }
  }

  element.loc = getSelection(context, element.loc.start)

  // 还原当前解析上下文
  if (isPreBoundary) {
    context.inPre = false
  }
  if (isVPreBoundary) {
    context.inVPre = false
  }
  return element
}

const enum TagType {
  Start,
  End
}

const isSpecialTemplateDirective = /*#__PURE__*/ makeMap(
  `if,else,else-if,for,slot`
)

/**
 * Parse a tag (E.g. `<div id=a>`) with that type (start tag or end tag).
 */
function parseTag(
  context: ParserContext,
  type: TagType.Start,
  parent: ElementNode | undefined
): ElementNode
function parseTag(
  context: ParserContext,
  type: TagType.End,
  parent: ElementNode | undefined
): void
function parseTag(
  context: ParserContext,
  type: TagType,
  parent: ElementNode | undefined
): ElementNode | undefined {
  __TEST__ && assert(/^<\/?[a-z]/i.test(context.source))
  __TEST__ &&
    assert(
      type === (startsWith(context.source, '</') ? TagType.End : TagType.Start)
    )

  // Tag open.
  // 获取当前解析上下文信息
  const start = getCursor(context)

  // 获取标签名
  const match = /^<\/?([a-z][^\t\r\n\f />]*)/i.exec(context.source)!
  const tag = match[1]
  const ns = context.options.getNamespace(tag, parent)

  // 更新解析上下文(更新<tag长度)
  advanceBy(context, match[0].length)

  // 跳过tag到属性间的空格距离，更新解析上下文
  advanceSpaces(context)

  // save current state in case we need to re-parse attributes with v-pre
  // 存储当前的解析上下文信息、模板，因为之后可能会再次解析
  const cursor = getCursor(context)
  const currentSource = context.source

  // check <pre> tag
  if (context.options.isPreTag(tag)) {
    context.inPre = true
  }

  // Attributes.
  // 解析属性
  let props = parseAttributes(context, type)

  // check v-pre
  // 如果当前标签具有v-pre属性(开标签)
  if (
    type === TagType.Start &&
    !context.inVPre &&
    props.some(p => p.type === NodeTypes.DIRECTIVE && p.name === 'pre')
  ) {
    // 更新解析上下文
    context.inVPre = true
    // reset context
    // 重置解析信息到未解析前
    extend(context, cursor)
    context.source = currentSource
    // re-parse attrs and filter out v-pre itself
    // 重新解析，并移除v-pre这个属性
    // 这里为什么要重新解析，因为在v-pre环境中不存在动态属性，
    // 此时对属性解析有影响，所以属性都会解析为静态属性
    props = parseAttributes(context, type).filter(p => p.name !== 'v-pre')
  }

  // Tag close.
  // 是否为自闭合标签
  let isSelfClosing = false

  // 模板已解析完毕，报错
  if (context.source.length === 0) {
    emitError(context, ErrorCodes.EOF_IN_TAG)
  } else {
    // 检查是否为自闭和标签
    isSelfClosing = startsWith(context.source, '/>')

    // 如果是一个带有自闭和符号的尾标签则报错
    if (type === TagType.End && isSelfClosing) {
      emitError(context, ErrorCodes.END_TAG_WITH_TRAILING_SOLIDUS)
    }
    advanceBy(context, isSelfClosing ? 2 : 1)
  }

  // 闭合标签解析到此结束
  if (type === TagType.End) {
    return
  }

  // 2.x deprecation checks
  if (
    __COMPAT__ &&
    __DEV__ &&
    isCompatEnabled(
      CompilerDeprecationTypes.COMPILER_V_IF_V_FOR_PRECEDENCE,
      context
    )
  ) {
    let hasIf = false
    let hasFor = false
    for (let i = 0; i < props.length; i++) {
      const p = props[i]
      if (p.type === NodeTypes.DIRECTIVE) {
        if (p.name === 'if') {
          hasIf = true
        } else if (p.name === 'for') {
          hasFor = true
        }
      }
      if (hasIf && hasFor) {
        warnDeprecation(
          CompilerDeprecationTypes.COMPILER_V_IF_V_FOR_PRECEDENCE,
          context,
          getSelection(context, start)
        )
      }
    }
  }

  // 确认元素类型，默认类型为元素
  let tagType = ElementTypes.ELEMENT

  // 确认不在v-pre环境中
  if (!context.inVPre) {
    // 插槽
    if (tag === 'slot') {
      tagType = ElementTypes.SLOT

      // 模板
    } else if (tag === 'template') {
      // 模板上是否具有特殊指令，有时才记录当前模板，否则无视
      if (
        props.some(
          p =>
            p.type === NodeTypes.DIRECTIVE && isSpecialTemplateDirective(p.name)
        )
      ) {
        tagType = ElementTypes.TEMPLATE
      }

      // 是否为组件
    } else if (isComponent(tag, props, context)) {
      tagType = ElementTypes.COMPONENT
    }
  }

  return {
    type: NodeTypes.ELEMENT,
    ns,
    tag,
    tagType,
    props,
    isSelfClosing,
    children: [],
    loc: getSelection(context, start),
    codegenNode: undefined // to be created during transform phase
  }
}

function isComponent(
  tag: string,
  props: (AttributeNode | DirectiveNode)[],
  context: ParserContext
) {
  const options = context.options

  // 首先是否为自定义元素(需用户注册)
  if (options.isCustomElement(tag)) {
    return false
  }

  // 是否为组件
  if (
    // 是否为动态组件
    tag === 'component' ||
    // 是否为Class写法
    /^[A-Z]/.test(tag) ||
    // 是否为自有核心组件
    isCoreComponent(tag) ||
    // 是否为内置组件
    (options.isBuiltInComponent && options.isBuiltInComponent(tag)) ||
    // 否原生元素
    (options.isNativeTag && !options.isNativeTag(tag))
  ) {
    return true
  }

  // at this point the tag should be a native tag, but check for potential "is"
  // casting
  // 到了这一步该标签应该为原生标签，但注意可能会存在is属性
  // 主要是处理v-is情况
  for (let i = 0; i < props.length; i++) {
    const p = props[i]

    // 属性类型的is
    if (p.type === NodeTypes.ATTRIBUTE) {
      // 具有is属性且有值，值必须标记vue:
      if (p.name === 'is' && p.value) {
        if (p.value.content.startsWith('vue:')) {
          return true
        } else if (
          __COMPAT__ &&
          checkCompatEnabled(
            CompilerDeprecationTypes.COMPILER_IS_ON_ELEMENT,
            context,
            p.loc
          )
        ) {
          return true
        }
      }

      // 指令形is，未来移除
    } else {
      // directive
      // v-is (TODO Deprecate)
      if (p.name === 'is') {
        return true
      } else if (
        // :is on plain element - only treat as component in compat mode
        p.name === 'bind' &&
        isBindKey(p.arg, 'is') &&
        __COMPAT__ &&
        checkCompatEnabled(
          CompilerDeprecationTypes.COMPILER_IS_ON_ELEMENT,
          context,
          p.loc
        )
      ) {
        return true
      }
    }
  }
}

function parseAttributes(
  context: ParserContext,
  type: TagType
): (AttributeNode | DirectiveNode)[] {
  const props = []
  const attributeNames = new Set<string>()

  // 循环解析，直到标签末尾或者模板解析完毕
  while (
    context.source.length > 0 &&
    !startsWith(context.source, '>') &&
    !startsWith(context.source, '/>')
  ) {
    // 单个/，能进入到此处说明其不为/>，报错并mute掉该/
    if (startsWith(context.source, '/')) {
      emitError(context, ErrorCodes.UNEXPECTED_SOLIDUS_IN_TAG)
      advanceBy(context, 1)
      advanceSpaces(context)
      continue
    }

    // 当前解析类型为尾标签，报错，尾标签写属性
    if (type === TagType.End) {
      emitError(context, ErrorCodes.END_TAG_WITH_ATTRIBUTES)
    }

    // 解析属性，存入Set中
    const attr = parseAttribute(context, attributeNames)

    // 如果为开标签，则记录属性信息
    if (type === TagType.Start) {
      props.push(attr)
    }

    // 当前属性解析完毕，如果距离下个属性没有空格则报错
    if (/^[^\t\r\n\f />]/.test(context.source)) {
      emitError(context, ErrorCodes.MISSING_WHITESPACE_BETWEEN_ATTRIBUTES)
    }

    // 跳过空格内容
    advanceSpaces(context)
  }
  return props
}

// 解析单个属性
function parseAttribute(
  context: ParserContext,
  nameSet: Set<string>
): AttributeNode | DirectiveNode {
  __TEST__ && assert(/^[^\t\r\n\f />]/.test(context.source))

  // Name.
  const start = getCursor(context)

  // 获取属性名称
  const match = /^[^\t\r\n\f />][^\t\r\n\f />=]*/.exec(context.source)!
  const name = match[0]

  // 重复属性报错
  if (nameSet.has(name)) {
    emitError(context, ErrorCodes.DUPLICATE_ATTRIBUTE)
  }
  nameSet.add(name)

  // 缺少属性名称
  if (name[0] === '=') {
    emitError(context, ErrorCodes.UNEXPECTED_EQUALS_SIGN_BEFORE_ATTRIBUTE_NAME)
  }

  // 属性名中有奇怪的符号报错
  {
    const pattern = /["'<]/g
    let m: RegExpExecArray | null
    while ((m = pattern.exec(name))) {
      emitError(
        context,
        ErrorCodes.UNEXPECTED_CHARACTER_IN_ATTRIBUTE_NAME,
        m.index
      )
    }
  }

  // 更新解析上下文
  advanceBy(context, name.length)

  // Value
  let value: AttributeValue = undefined

  // 解析属性值，属性名到=号前允许换行空格
  if (/^[\t\r\n\f ]*=/.test(context.source)) {
    // 跳过空格部分
    advanceSpaces(context)

    // 跳过=号
    advanceBy(context, 1)

    // 再次跳过空格
    advanceSpaces(context)

    // 解析属性，返回其ast对象
    value = parseAttributeValue(context)

    // 未解析到属性值，报错
    if (!value) {
      emitError(context, ErrorCodes.MISSING_ATTRIBUTE_VALUE)
    }
  }

  // 获取当前属性整体的位置信息
  const loc = getSelection(context, start)

  if (!context.inVPre && /^(v-|:|\.|@|#)/.test(name)) {
    const match =
      /(?:^v-([a-z0-9-]+))?(?:(?::|^\.|^@|^#)(\[[^\]]+\]|[^\.]+))?(.+)?$/i.exec(
        name
      )!

    let isPropShorthand = startsWith(name, '.')
    let dirName =
      match[1] ||
      (isPropShorthand || startsWith(name, ':')
        ? 'bind'
        : startsWith(name, '@')
        ? 'on'
        : 'slot')
    let arg: ExpressionNode | undefined

    // 当解析为语法糖时，解析到的名称在2位置
    if (match[2]) {
      const isSlot = dirName === 'slot'
      const startOffset = name.lastIndexOf(match[2])
      const loc = getSelection(
        context,
        getNewPosition(context, start, startOffset),
        getNewPosition(
          context,
          start,
          startOffset + match[2].length + ((isSlot && match[3]) || '').length
        )
      )
      let content = match[2]

      // 是否为静态属性名
      let isStatic = true

      // 属性名为动态的
      if (content.startsWith('[')) {
        isStatic = false

        // 动态属性名缺乏闭合符号
        if (!content.endsWith(']')) {
          emitError(
            context,
            ErrorCodes.X_MISSING_DYNAMIC_DIRECTIVE_ARGUMENT_END
          )
        }

        // 获取动态属性具体字段
        content = content.substr(1, content.length - 2)
      } else if (isSlot) {
        // #1241 special case for v-slot: vuetify relies extensively on slot
        // names containing dots. v-slot doesn't have any modifiers and Vue 2.x
        // supports such usage so we are keeping it consistent with 2.x.
        content += match[3] || ''
      }

      arg = {
        type: NodeTypes.SIMPLE_EXPRESSION,
        content,
        isStatic,
        constType: isStatic
          ? ConstantTypes.CAN_STRINGIFY
          : ConstantTypes.NOT_CONSTANT,
        loc
      }
    }

    if (value && value.isQuoted) {
      const valueLoc = value.loc
      valueLoc.start.offset++
      valueLoc.start.column++
      valueLoc.end = advancePositionWithClone(valueLoc.start, value.content)
      valueLoc.source = valueLoc.source.slice(1, -1)
    }

    // 获取修饰符
    const modifiers = match[3] ? match[3].substr(1).split('.') : []
    if (isPropShorthand) modifiers.push('prop')

    // 2.x compat v-bind:foo.sync -> v-model:foo
    if (__COMPAT__ && dirName === 'bind' && arg) {
      if (
        modifiers.includes('sync') &&
        checkCompatEnabled(
          CompilerDeprecationTypes.COMPILER_V_BIND_SYNC,
          context,
          loc,
          arg.loc.source
        )
      ) {
        dirName = 'model'
        modifiers.splice(modifiers.indexOf('sync'), 1)
      }

      if (__DEV__ && modifiers.includes('prop')) {
        checkCompatEnabled(
          CompilerDeprecationTypes.COMPILER_V_BIND_PROP,
          context,
          loc
        )
      }
    }

    // 返回单个属性的ast对象
    return {
      // 动态属性为指令
      type: NodeTypes.DIRECTIVE,
      name: dirName,
      exp: value && {
        type: NodeTypes.SIMPLE_EXPRESSION,
        content: value.content,
        isStatic: false,
        // Treat as non-constant by default. This can be potentially set to
        // other values by `transformExpression` to make it eligible for hoisting.
        constType: ConstantTypes.NOT_CONSTANT,
        loc: value.loc
      },
      arg,
      modifiers,
      loc
    }
  }

  return {
    // 静态属性为attribute
    type: NodeTypes.ATTRIBUTE,
    name,
    value: value && {
      type: NodeTypes.TEXT,
      content: value.content,
      loc: value.loc
    },
    loc
  }
}

function parseAttributeValue(context: ParserContext): AttributeValue {
  // 保存当前解析上下文信息
  const start = getCursor(context)
  let content: string

  // 当前属性的引号
  const quote = context.source[0]

  // 是否为单双引号
  const isQuoted = quote === `"` || quote === `'`

  if (isQuoted) {
    // Quoted value.
    // 跳过引号的长度距离
    advanceBy(context, 1)

    // 找到反引号位置
    const endIndex = context.source.indexOf(quote)

    // 没找到，那么将后面全部内容都视为属性值
    if (endIndex === -1) {
      content = parseTextData(
        context,
        context.source.length,
        TextModes.ATTRIBUTE_VALUE
      )

      // 找到反引号，解析中间的属性值
    } else {
      content = parseTextData(context, endIndex, TextModes.ATTRIBUTE_VALUE)

      // 跳过后引号距离
      advanceBy(context, 1)
    }

    // 没有引号时，浏览器将认为其和有引号一样(虽然写法不规范)
  } else {
    // Unquoted

    // 匹配属性值
    const match = /^[^\t\r\n\f >]+/.exec(context.source)
    if (!match) {
      return undefined
    }

    // 查看当前属性值中是否有不该出现的符号，报错
    const unexpectedChars = /["'<=`]/g
    let m: RegExpExecArray | null
    while ((m = unexpectedChars.exec(match[0]))) {
      emitError(
        context,
        ErrorCodes.UNEXPECTED_CHARACTER_IN_UNQUOTED_ATTRIBUTE_VALUE,
        m.index
      )
    }

    // 提取具体属性值
    content = parseTextData(context, match[0].length, TextModes.ATTRIBUTE_VALUE)
  }

  // 返回属性的ast对象
  return { content, isQuoted, loc: getSelection(context, start) }
}

function parseInterpolation(
  context: ParserContext,
  mode: TextModes
): InterpolationNode | undefined {
  // 获取茶产值表达式分隔符
  const [open, close] = context.options.delimiters
  __TEST__ && assert(startsWith(context.source, open))

  // 获取插值表达式闭合处下标
  const closeIndex = context.source.indexOf(close, open.length)

  // 未找到时报错
  if (closeIndex === -1) {
    emitError(context, ErrorCodes.X_MISSING_INTERPOLATION_END)
    return undefined
  }

  // 获取开始插值表达式开始标签位置信息
  const start = getCursor(context)

  // 更新解析上下文信息，此时模板已经更新
  advanceBy(context, open.length)

  // 获取插值表达式内容开始信息
  const innerStart = getCursor(context)
  const innerEnd = getCursor(context)

  // 插值表达式内容长度
  const rawContentLength = closeIndex - open.length

  // 插值表达式具体内容
  const rawContent = context.source.slice(0, rawContentLength)

  // 获取纯插值表达式内容(未处理空格)
  const preTrimContent = parseTextData(context, rawContentLength, mode)

  // 除去空格
  const content = preTrimContent.trim()

  // 获取到正式内容的位移
  const startOffset = preTrimContent.indexOf(content)

  // 记录插值内容开始信息，注意下面用的是之前位置信息的副本
  if (startOffset > 0) {
    advancePositionWithMutation(innerStart, rawContent, startOffset)
  }

  // 获取内容结尾到插值表达式边缘的位移(同上使用副本)
  const endOffset =
    rawContentLength - (preTrimContent.length - content.length - startOffset)
  advancePositionWithMutation(innerEnd, rawContent, endOffset)

  // 更新模板
  advanceBy(context, close.length)

  return {
    type: NodeTypes.INTERPOLATION,
    content: {
      type: NodeTypes.SIMPLE_EXPRESSION,
      isStatic: false,
      // Set `isConstant` to false by default and will decide in transformExpression
      constType: ConstantTypes.NOT_CONSTANT,
      content,

      // 保存选中区域信息
      loc: getSelection(context, innerStart, innerEnd)
    },

    // 整体插值表达式(包括括号)的位置信息
    loc: getSelection(context, start)
  }
}

// 解析文本
function parseText(context: ParserContext, mode: TextModes): TextNode {
  __TEST__ && assert(context.source.length > 0)

  // 默认解析到下面符号前
  const endTokens = ['<', context.options.delimiters[0]]
  if (mode === TextModes.CDATA) {
    endTokens.push(']]>')
  }

  // 默认将之后全部内容视为文本
  let endIndex = context.source.length

  // 遍历所有符号查找文本结束位置
  for (let i = 0; i < endTokens.length; i++) {
    const index = context.source.indexOf(endTokens[i], 1)

    // 找到最短的一个文本下标
    if (index !== -1 && endIndex > index) {
      endIndex = index
    }
  }

  __TEST__ && assert(endIndex > 0)

  // 获取位置，提取文本
  const start = getCursor(context)
  const content = parseTextData(context, endIndex, mode)

  return {
    type: NodeTypes.TEXT,
    content,
    loc: getSelection(context, start)
  }
}

/**
 * Get text data with a given length from the current location.
 * This translates HTML entities in the text data.
 * 从当前位置获取一个给定长度的文本信息
 */
function parseTextData(
  context: ParserContext,
  length: number,
  mode: TextModes
): string {
  // 获取文本
  const rawText = context.source.slice(0, length)

  // 更新解析上下文
  advanceBy(context, length)

  // 返回解析的文本片段
  if (
    mode === TextModes.RAWTEXT ||
    mode === TextModes.CDATA ||
    rawText.indexOf('&') === -1
  ) {
    return rawText
  } else {
    // DATA or RCDATA containing "&"". Entity decoding required.
    // 自动解码
    return context.options.decodeEntities(
      rawText,
      mode === TextModes.ATTRIBUTE_VALUE
    )
  }
}

// 获取当前解析指针
function getCursor(context: ParserContext): Position {
  const { column, line, offset } = context
  return { column, line, offset }
}

// 获取选中区域内容
function getSelection(
  context: ParserContext,
  start: Position,
  end?: Position
): SourceLocation {
  // 未标记结尾时，使用当前解析上下文的位置
  end = end || getCursor(context)
  return {
    start,
    end,
    source: context.originalSource.slice(start.offset, end.offset)
  }
}

function last<T>(xs: T[]): T | undefined {
  return xs[xs.length - 1]
}

function startsWith(source: string, searchString: string): boolean {
  return source.startsWith(searchString)
}

// 更新解析上下文信息
function advanceBy(context: ParserContext, numberOfCharacters: number): void {
  const { source } = context
  __TEST__ && assert(numberOfCharacters <= source.length)

  // 更新解析上下文信息
  advancePositionWithMutation(context, source, numberOfCharacters)

  // 直接截取到剩余的模板
  context.source = source.slice(numberOfCharacters)
}

function advanceSpaces(context: ParserContext): void {
  const match = /^[\t\r\n\f ]+/.exec(context.source)
  if (match) {
    advanceBy(context, match[0].length)
  }
}

function getNewPosition(
  context: ParserContext,
  start: Position,
  numberOfCharacters: number
): Position {
  return advancePositionWithClone(
    start,
    context.originalSource.slice(start.offset, numberOfCharacters),
    numberOfCharacters
  )
}

function emitError(
  context: ParserContext,
  code: ErrorCodes,
  offset?: number,
  loc: Position = getCursor(context)
): void {
  if (offset) {
    loc.offset += offset
    loc.column += offset
  }
  context.options.onError(
    createCompilerError(code, {
      start: loc,
      end: loc,
      source: ''
    })
  )
}

// 检测是否解析到模板最后
function isEnd(
  context: ParserContext,
  mode: TextModes,
  ancestors: ElementNode[]
): boolean {
  // 获取当前正在解析到的模板
  const s = context.source

  switch (mode) {
    case TextModes.DATA:
      // 当前模板是否为结束标签
      if (startsWith(s, '</')) {
        // TODO: probably bad performance
        // 从未闭合元素(父->祖先)开始，查看是否为匹配的尾标签
        for (let i = ancestors.length - 1; i >= 0; --i) {
          // 匹配当前闭合标签
          if (startsWithEndTagOpen(s, ancestors[i].tag)) {
            return true
          }
        }
      }
      break

    case TextModes.RCDATA:
    case TextModes.RAWTEXT: {
      const parent = last(ancestors)
      if (parent && startsWithEndTagOpen(s, parent.tag)) {
        return true
      }
      break
    }

    case TextModes.CDATA:
      if (startsWith(s, ']]>')) {
        return true
      }
      break
  }

  // 返回当前模板是否解析完毕
  return !s
}

// 尾标签匹配
function startsWithEndTagOpen(source: string, tag: string): boolean {
  return (
    startsWith(source, '</') &&
    // 当前闭合标签匹配目标标签
    source.substr(2, tag.length).toLowerCase() === tag.toLowerCase() &&
    /[\t\r\n\f />]/.test(source[2 + tag.length] || '>')
  )
}
