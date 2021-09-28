import {
  ConstantTypes,
  RootNode,
  NodeTypes,
  TemplateChildNode,
  SimpleExpressionNode,
  ElementTypes,
  PlainElementNode,
  ComponentNode,
  TemplateNode,
  VNodeCall,
  ParentNode,
  JSChildNode,
  CallExpression,
  createArrayExpression
} from '../ast'
import { TransformContext } from '../transform'
import { PatchFlags, isString, isSymbol, isArray } from '@vue/shared'
import { getVNodeBlockHelper, getVNodeHelper, isSlotOutlet } from '../utils'
import {
  OPEN_BLOCK,
  GUARD_REACTIVE_PROPS,
  NORMALIZE_CLASS,
  NORMALIZE_PROPS,
  NORMALIZE_STYLE
} from '../runtimeHelpers'

// 提升静态节点
export function hoistStatic(root: RootNode, context: TransformContext) {
  walk(
    root,
    context,
    // Root node is unfortunately non-hoistable due to potential parent
    // fallthrough attributes.
    // 单个根节点时，由于父级上下文可能会透传属性所以导致其不能提升静态
    isSingleElementRoot(root, root.children[0])
  )
}

// 是否为单个根节点Root(根节点不能为插槽)
export function isSingleElementRoot(
  root: RootNode,
  child: TemplateChildNode
): child is PlainElementNode | ComponentNode | TemplateNode {
  const { children } = root
  return (
    children.length === 1 &&
    child.type === NodeTypes.ELEMENT &&
    !isSlotOutlet(child)
  )
}

function walk(
  // 遍历的顶级节点
  node: ParentNode,

  // 转化上下文
  context: TransformContext,

  // 不进行静态节点提升
  doNotHoistNode: boolean = false
) {
  // Some transforms, e.g. transformAssetUrls from @vue/compiler-sfc, replaces
  // static bindings with expressions. These expressions are guaranteed to be
  // constant so they are still eligible for hoisting, but they are only
  // available at runtime and therefore cannot be evaluated ahead of time.
  // This is only a concern for pre-stringification (via transformHoist by
  // @vue/compiler-dom), but doing it here allows us to perform only one full
  // walk of the AST and allow `stringifyStatic` to stop walking as soon as its
  // stringification threshold is met.
  let canStringify = true

  const { children } = node
  const originalCount = children.length

  // 提升的子节点数量
  let hoistedCount = 0

  for (let i = 0; i < children.length; i++) {
    const child = children[i]

    // only plain elements & text calls are eligible for hoisting.
    // 只有普通元素和文本可以被提升为静态节点
    // 1. 当前子元素为普通元素
    // 2. 文本调度表达式
    if (
      child.type === NodeTypes.ELEMENT &&
      child.tagType === ElementTypes.ELEMENT
    ) {
      // 获取当前子节点应该的常量类型
      const constantType = doNotHoistNode
        ? // 父节点不允许提升节点时，将当前节点置为非常量
          ConstantTypes.NOT_CONSTANT
        : // 其他情况时，获取当前子节点解析时的常量类型(会取整个节点树的最低下限)
          getConstantType(child, context)

      // 当前节点不是非常量时
      if (constantType > ConstantTypes.NOT_CONSTANT) {
        // 非最高级常量时，标记
        if (constantType < ConstantTypes.CAN_STRINGIFY) {
          canStringify = false
        }

        // 当前节点可以提升
        if (constantType >= ConstantTypes.CAN_HOIST) {
          // 标记patchFlag
          ;(child.codegenNode as VNodeCall).patchFlag =
            PatchFlags.HOISTED + (__DEV__ ? ` /* HOISTED */` : ``)

          // 重写codegen节点
          child.codegenNode = context.hoist(child.codegenNode!)
          hoistedCount++
          continue
        }

        // 非常量节点
      } else {
        // node may contain dynamic children, but its props may be eligible for
        // hoisting.
        // 节点可能包含动态子节点，但节点的属性可能可以提升
        const codegenNode = child.codegenNode!

        // 确定当前节点为Vnode创建调用函数
        if (codegenNode.type === NodeTypes.VNODE_CALL) {
          // 获取当前codegenNode的patchFlag
          const flag = getPatchFlag(codegenNode)
          if (
            (!flag ||
              flag === PatchFlags.NEED_PATCH ||
              flag === PatchFlags.TEXT) &&
            // 确保props的下限都可以进行提升
            getGeneratedPropsConstantType(child, context) >=
              ConstantTypes.CAN_HOIST
          ) {
            const props = getNodeProps(child)

            // 提升当前节点的props
            if (props) {
              codegenNode.props = context.hoist(props)
            }
          }

          // 有动态属性时，提升这些动态属性
          if (codegenNode.dynamicProps) {
            codegenNode.dynamicProps = context.hoist(codegenNode.dynamicProps)
          }
        }
      }

      // 当其为文本调用表达式时
    } else if (child.type === NodeTypes.TEXT_CALL) {
      // 获取其内容的常量类型
      const contentType = getConstantType(child.content, context)
      if (contentType > 0) {
        if (contentType < ConstantTypes.CAN_STRINGIFY) {
          canStringify = false
        }

        // 下限超过HOIST时，提升
        if (contentType >= ConstantTypes.CAN_HOIST) {
          child.codegenNode = context.hoist(child.codegenNode)
          hoistedCount++
        }
      }
    }

    // walk further
    // 继续遍历其他节点
    // 确认其为标签AST
    if (child.type === NodeTypes.ELEMENT) {
      // 是否为组件
      const isComponent = child.tagType === ElementTypes.COMPONENT

      // 为组件时，标记作用域插槽深度
      if (isComponent) {
        context.scopes.vSlot++
      }

      // 递归计算子节点
      walk(child, context)
      if (isComponent) {
        context.scopes.vSlot--
      }

      // FOR容器AST
    } else if (child.type === NodeTypes.FOR) {
      // Do not hoist v-for single child because it has to be a block
      walk(child, context, child.children.length === 1)

      // IF容器AST
    } else if (child.type === NodeTypes.IF) {
      for (let i = 0; i < child.branches.length; i++) {
        // Do not hoist v-if single child because it has to be a block
        walk(
          child.branches[i],
          context,
          child.branches[i].children.length === 1
        )
      }
    }
  }

  // 非浏览器
  if (canStringify && hoistedCount && context.transformHoist) {
    context.transformHoist(children, context, node)
  }

  // all children were hoisted - the entire children array is hoistable.
  // 当子节点都被提升时，那说明整个子节点都是可提升的
  if (
    hoistedCount &&
    hoistedCount === originalCount &&
    node.type === NodeTypes.ELEMENT &&
    node.tagType === ElementTypes.ELEMENT &&
    node.codegenNode &&
    node.codegenNode.type === NodeTypes.VNODE_CALL &&
    isArray(node.codegenNode.children)
  ) {
    node.codegenNode.children = context.hoist(
      createArrayExpression(node.codegenNode.children)
    )
  }
}

export function getConstantType(
  node: TemplateChildNode | SimpleExpressionNode,
  context: TransformContext
): ConstantTypes {
  // 获取历史缓存
  const { constantCache } = context

  // 根据当前AST节点类型进行处理
  switch (node.type) {
    // 作为标签的元素节点
    case NodeTypes.ELEMENT:
      // 非元素返回非常量
      if (node.tagType !== ElementTypes.ELEMENT) {
        return ConstantTypes.NOT_CONSTANT
      }

      // 获取当前节点的常量类型缓存
      const cached = constantCache.get(node)
      if (cached !== undefined) {
        return cached
      }

      // 未获取到时，查看最终的codegenNode的类型
      const codegenNode = node.codegenNode!

      // 非普通的VNode节点创建调用时，返回非常量类型
      if (codegenNode.type !== NodeTypes.VNODE_CALL) {
        return ConstantTypes.NOT_CONSTANT
      }

      // 当其为VNode调用时，查看其patchFlag上的标记决定
      const flag = getPatchFlag(codegenNode)
      /**
       * 无任何标记，则说明可以被常量化，执行三种测试：
       * 1. 检查属性
       * 2. 检查子节点
       * 3.
       * 最后按当前节点及其子节点的下限为标准返回常量类型
       */
      if (!flag) {
        // 定义其常量类型为最高
        let returnType = ConstantTypes.CAN_STRINGIFY

        // Element itself has no patch flag. However we still need to check:
        // 元素自身虽然没有patchFlag。但是我们仍要去检查一下几点：

        // 1. Even for a node with no patch flag, it is possible for it to contain
        // non-hoistable expressions that refers to scope variables, e.g. compiler
        // injected keys or cached event handlers. Therefore we need to always
        // check the codegenNode's props to be sure.
        // 1. 虽然一个节点没有patchFlag，但它仍可能含有不可提升的表达式，比如编译过程中，
        // 注入的key或缓存的事件处理器，所以我们需要检查codegenNode的props来确认
        const generatedPropsType = getGeneratedPropsConstantType(node, context)

        // 如果为非常量则直接返回
        if (generatedPropsType === ConstantTypes.NOT_CONSTANT) {
          constantCache.set(node, ConstantTypes.NOT_CONSTANT)
          return ConstantTypes.NOT_CONSTANT
        }

        // 其余情况更新下限
        if (generatedPropsType < returnType) {
          returnType = generatedPropsType
        }

        // 2. its children.
        // 检查子节点
        for (let i = 0; i < node.children.length; i++) {
          // 递归检查子节点，返回子节点常量类型
          const childType = getConstantType(node.children[i], context)

          // 子节点为非常量时，直接返回
          if (childType === ConstantTypes.NOT_CONSTANT) {
            constantCache.set(node, ConstantTypes.NOT_CONSTANT)
            return ConstantTypes.NOT_CONSTANT
          }

          // 如果子节点类型小于父节点，那么父节点像子节点降级，更新下限
          if (childType < returnType) {
            returnType = childType
          }
        }

        // 3. if the type is not already CAN_SKIP_PATCH which is the lowest non-0
        // type, check if any of the props can cause the type to be lowered
        // we can skip can_patch because it's guaranteed by the absence of a
        // patchFlag.
        // 3. 如果当前类型不是 可跳过patch 类型(这是最低的非常量类型)。检查是否有props会导致其降级
        if (returnType > ConstantTypes.CAN_SKIP_PATCH) {
          for (let i = 0; i < node.props.length; i++) {
            const p = node.props[i]

            // v-bind:xx属性
            if (p.type === NodeTypes.DIRECTIVE && p.name === 'bind' && p.exp) {
              // 鉴定其绑定值的常量类型
              const expType = getConstantType(p.exp, context)

              // 非常量时直接返回
              if (expType === ConstantTypes.NOT_CONSTANT) {
                constantCache.set(node, ConstantTypes.NOT_CONSTANT)
                return ConstantTypes.NOT_CONSTANT
              }

              // 其他情况更新下限
              if (expType < returnType) {
                returnType = expType
              }
            }
          }
        }

        // only svg/foreignObject could be block here, however if they are
        // static then they don't need to be blocks since there will be no
        // nested updates.
        if (codegenNode.isBlock) {
          context.removeHelper(OPEN_BLOCK)
          context.removeHelper(
            getVNodeBlockHelper(context.inSSR, codegenNode.isComponent)
          )
          codegenNode.isBlock = false
          context.helper(getVNodeHelper(context.inSSR, codegenNode.isComponent))
        }

        constantCache.set(node, returnType)
        return returnType
      } else {
        // 其余情况直接返回非常量
        constantCache.set(node, ConstantTypes.NOT_CONSTANT)
        return ConstantTypes.NOT_CONSTANT
      }

    // 文本和注释直接返回最高级常量
    case NodeTypes.TEXT:
    case NodeTypes.COMMENT:
      return ConstantTypes.CAN_STRINGIFY

    // 分支及其容器返回非常量
    case NodeTypes.IF:
    case NodeTypes.FOR:
    case NodeTypes.IF_BRANCH:
      return ConstantTypes.NOT_CONSTANT

    // 插值表达式及其文本调用查询其常量类型后返回
    case NodeTypes.INTERPOLATION:
    case NodeTypes.TEXT_CALL:
      return getConstantType(node.content, context)

    // 简单表达式直接返回其节点常量类型
    case NodeTypes.SIMPLE_EXPRESSION:
      return node.constType

    // 复合表达式
    case NodeTypes.COMPOUND_EXPRESSION:
      // 默认最高级常量
      let returnType = ConstantTypes.CAN_STRINGIFY
      for (let i = 0; i < node.children.length; i++) {
        const child = node.children[i]

        // 文本跳过
        if (isString(child) || isSymbol(child)) {
          continue
        }

        // 获取子节点类型
        const childType = getConstantType(child, context)

        // 具有常量时直接返回
        if (childType === ConstantTypes.NOT_CONSTANT) {
          return ConstantTypes.NOT_CONSTANT

          // 更新下限
        } else if (childType < returnType) {
          returnType = childType
        }
      }
      return returnType

    // 其余情况返回非常亮
    default:
      if (__DEV__) {
        const exhaustiveCheck: never = node
        exhaustiveCheck
      }
      return ConstantTypes.NOT_CONSTANT
  }
}

const allowHoistedHelperSet = new Set([
  NORMALIZE_CLASS,
  NORMALIZE_STYLE,
  NORMALIZE_PROPS,
  GUARD_REACTIVE_PROPS
])

function getConstantTypeOfHelperCall(
  value: CallExpression,
  context: TransformContext
): ConstantTypes {
  // 有4种函数可以被提升
  if (
    value.type === NodeTypes.JS_CALL_EXPRESSION &&
    !isString(value.callee) &&
    allowHoistedHelperSet.has(value.callee)
  ) {
    // 查询其参数
    const arg = value.arguments[0] as JSChildNode

    // 参数为简单表达式时，检查其类型
    if (arg.type === NodeTypes.SIMPLE_EXPRESSION) {
      return getConstantType(arg, context)

      // 参数为JS调用表达式时，递归检查，例子为下述
    } else if (arg.type === NodeTypes.JS_CALL_EXPRESSION) {
      // in the case of nested helper call, e.g. `normalizeProps(guardReactiveProps(exp))`
      return getConstantTypeOfHelperCall(arg, context)
    }
  }
  return ConstantTypes.NOT_CONSTANT
}

// 获取属性的常量类型，以最低的为准
function getGeneratedPropsConstantType(
  node: PlainElementNode,
  context: TransformContext
): ConstantTypes {
  // 默认其类型为最高常量类型
  let returnType = ConstantTypes.CAN_STRINGIFY

  // 获取当前node的props数组
  const props = getNodeProps(node)

  // 确保目前属性的Shape为对象字面量
  if (props && props.type === NodeTypes.JS_OBJECT_EXPRESSION) {
    const { properties } = props

    // 遍历属性
    for (let i = 0; i < properties.length; i++) {
      const { key, value } = properties[i]

      // 获取属性名称常量类型
      const keyType = getConstantType(key, context)

      // 动态属性名称时，直接返回非常量类型
      if (keyType === ConstantTypes.NOT_CONSTANT) {
        return keyType
      }

      // 其他常量类型时，降低当前默认类型标准
      if (keyType < returnType) {
        returnType = keyType
      }
      let valueType: ConstantTypes

      // 当value为简单表达式时获取其类型
      if (value.type === NodeTypes.SIMPLE_EXPRESSION) {
        valueType = getConstantType(value, context)

        // 如果为函数调用表达式
      } else if (value.type === NodeTypes.JS_CALL_EXPRESSION) {
        // some helper calls can be hoisted,
        // such as the `normalizeProps` generated by the compiler for pre-normalize class,
        // in this case we need to respect the ConstantType of the helper's argments
        valueType = getConstantTypeOfHelperCall(value, context)
      } else {
        valueType = ConstantTypes.NOT_CONSTANT
      }
      if (valueType === ConstantTypes.NOT_CONSTANT) {
        return valueType
      }

      // 更新下限
      if (valueType < returnType) {
        returnType = valueType
      }
    }
  }
  return returnType
}

function getNodeProps(node: PlainElementNode) {
  const codegenNode = node.codegenNode!
  if (codegenNode.type === NodeTypes.VNODE_CALL) {
    return codegenNode.props
  }
}

function getPatchFlag(node: VNodeCall): number | undefined {
  const flag = node.patchFlag
  return flag ? parseInt(flag, 10) : undefined
}
