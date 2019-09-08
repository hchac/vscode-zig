import gdb
import re

def zig_pretty_printer(val):
    # print("type name: ", str(val.type), val.type.code)

    type_code = TypeCodes.get_type_code_for_gdb_type(val.type)
    if type_code == TypeCodes.NUMBER:
        return NumericPrinter(val)
    elif type_code == TypeCodes.ARRAY:
        return ArrayPrinter(val)
    elif type_code == TypeCodes.STRUCT:
        return StructPrinter(val)
    elif type_code == TypeCodes.POINTER:
        return PointerPrinter(val)
    elif type_code == TypeCodes.SLICE:
        return SlicePrinter(val)
    elif type_code == TypeCodes.FNPOINTER:
        return FunctionPointerPrinter(val)
    elif type_code == TypeCodes.ENUM:
        return EnumPrinter(val)

    return None

gdb.pretty_printers.append(zig_pretty_printer)


class TypeCodes():
    NUMBER      = "NUMBER"
    ARRAY       = "ARRAY"
    STRUCT      = "STRUCT"
    SLICE       = "SLICE"
    POINTER     = "POINTER"
    FNPOINTER   = "FNPOINTER"
    ENUM        = "ENUM"

    @staticmethod
    def get_type_code_for_gdb_type(gdb_type):
        gdb_type_code = gdb_type.code
        type_name = str(gdb_type)
        if gdb_type_code in [gdb.TYPE_CODE_CHAR, gdb.TYPE_CODE_INT, gdb.TYPE_CODE_FLT]:
            return TypeCodes.NUMBER
        elif gdb_type_code == gdb.TYPE_CODE_ARRAY:
            return TypeCodes.ARRAY
        elif gdb_type_code == gdb.TYPE_CODE_STRUCT:
            if type_name.startswith("struct []"):
                return TypeCodes.SLICE

            return TypeCodes.STRUCT
        elif gdb_type_code == gdb.TYPE_CODE_PTR:
            if re.match(r'^.+ \(\*+\)\(.+\)$', type_name):
                return TypeCodes.FNPOINTER

            return TypeCodes.POINTER
        elif gdb_type_code == gdb.TYPE_CODE_ENUM:
            return TypeCodes.ENUM

        return None


class NumericPrinter(object):
    def __init__(self, val):
        self.val = val

    def to_string(self):
        if self.val.type.code == gdb.TYPE_CODE_FLT:
            num = float(self.val)
        else:
            num = int(self.val)

        return "<{}> = {{{}}}".format(TypeCodes.NUMBER, num)


class ArrayPrinter(object):
    def __init__(self, val):
        self.val = val
        self.length = int(val.type.range()[1]) + 1

    def to_string(self):
        return "<{}>".format(TypeCodes.ARRAY)

    def children(self):
        for i in range(self.length):
            yield ("", self.val[i])

    def display_hint(self):
        return "array"


# class U8SlicePrinter(object):
#     def __init__(self, val):
#         self.val = val
#         self.pointer = self.val["ptr"]
#         self.length = int(self.val["len"])

#     def to_string(self):
#         decoded = self.pointer.string("utf-8", length = self.length)
#         string = bytearray(decoded, "utf-8")

#         # NOTE: The string to be printed needs to be the last thing being
#         # inserted into the our return string. The way that parsing will work is that
#         # when the parser knows it's time to parse the string, instead of immediately
#         # reading from the first quote, it will walk the whole slice output in gdb 
#         # backwards looking for the first '">' sequence it finds. Once it's found,
#         # it knows where the user's string starts and ends. Reason for this is because the 
#         # user could have inserted their own '">' sequence and thus breaking parsing.
#         return "<{}; \"{}\">".format(TypeCodes.STRUCT, string)

#     def children(self):
#         for i in range(self.length):
#             yield ("", (self.pointer + i).dereference())

#     def display_hint(self):
#         return "array"


class StructPrinter(object):
    def __init__(self, val):
        self.val = val

    def to_string(self):
        return "<{}>".format(TypeCodes.STRUCT)

    def children(self):
        optional_struct = "?" in str(self.val.type)
        for v in self.val.type.fields():
            # TODO: having issues with the maybe field
            # in a optional struct crashing gdb
            if v.name == "maybe" and optional_struct:
                continue

            yield ("", v.name)

            type_code = TypeCodes.get_type_code_for_gdb_type(v.type)
            # TODO: need to move this logic of figuring out who's printable or
            # not to a better place.
            if type_code in [TypeCodes.NUMBER, TypeCodes.ENUM, TypeCodes.FNPOINTER]:
                # These are not expensive to look up, by which I mean
                # that they won't go out recursively defining more data types
                # to look up and print.
                yield ("", "{}".format(self.val[v.name]))
            else:
                # To be more efficient, lets only print out the type code of
                # this complex type. Let the programmer ask for the value
                # later.
                 # NOTE: ! indicates to the parser that it will need to evaluate
                # this field in order to get its value.
                yield ("", "<{}> = !".format(type_code))

    def display_hint(self):
        return "map"


class SlicePrinter(object):
    def __init__(self, val):
        self.val = val
        self.pointer = self.val["ptr"]
        self.length = int(self.val["len"])

        # element_bit_length = re.match(r'^struct \[\][u|i](\d)+', str(val.type)).group(1)
        # if element_bit_length not in ['8', '16', '32', '64', '128']:
        #     del(self.children)

    def to_string(self):
        return "<{}>".format(TypeCodes.SLICE)

    def children(self):
        yield ("", "ptr")
        # NOTE: not marking this as a pointer as we don't necessarily want
        # the UI to follow the pointer to the first element. To show the elements
        # being pointed to, we should take a different approach.
        yield ("", "<{}> = {{{}}}".format(TypeCodes.NUMBER, hex(int(self.pointer))))
        yield ("", "len")
        yield ("", "<{}> = {{{}}}".format(TypeCodes.NUMBER, self.length))

        # for i in range(self.length):
        #     yield ("", (self.pointer + i).dereference())

    def display_hint(self):
        return "map"


class PointerPrinter(object):
    def __init__(self, val):
        self.val = val

    def to_string(self):
        addr = hex(int(self.val))
        return "<{}> = {{{}}}".format(TypeCodes.POINTER, addr)


class FunctionPointerPrinter(object):
    def __init__(self, val):
        self.val = val

    def to_string(self):
        fn_addr = int(self.val)
        return "<{}> = {{{}}}".format(TypeCodes.FNPOINTER, hex(fn_addr))
        # fn_symbol = gdb.block_for_pc(fn_addr).function
        # fn_name = fn_symbol.print_name
        # fn_file = fn_symbol.symtab.filename
        # fn_line = fn_symbol.line
        # return "<{}> = {{[addr] = {}, [name] = {}, [file] = {}, [line] = {}}}".format(
        #     TypeCodes.FNPOINTER, hex(fn_addr), fn_name, fn_file, fn_line
        # )


class EnumPrinter(object):
    def __init__(self, val):
        self.val = val

    def to_string(self):
        enum_field = self.val.type.fields()[int(self.val)]
        return "<{}> = {{{}}}".format(TypeCodes.ENUM, enum_field.name)
