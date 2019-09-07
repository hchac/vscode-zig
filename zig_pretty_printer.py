import gdb
import re


def zig_pretty_printer(val):
    if val == None or val.type == None:
        print("Value or its type is None")
        return

    type_name = str(val.type)
    # print("type name: ", type_name)

    if re.match(r'.+\[\d+\]$', type_name):
        # Examples:
        #   "u8 [12]"           => Array of 12 u8's
        #   "struct []u8 [3]"   => Array of 3 u8 slices
        return ArrayPrinter(val)
    # elif type_name == "struct []u8":
    #     return U8SlicePrinter(val)
    elif type_name.endswith("*"):
        return PointerPrinter(val)
    elif re.match(r'^struct \[\]', type_name):
        # Examples:
        #   "struct [][]u8"   => Slice of u8 slices
        return SlicePrinter(val)
    elif type_name.startswith("struct"):
        return StructPrinter(val)
    elif re.match(r'^.+ \(\*+\)\(.+\)$', type_name):
        return FunctionPointerPrinter(val)
    elif re.match(r'^[u|i|f]\d+$', type_name) or type_name == "usize" or type_name == "isize":
        return NumericPrinter(val)

    return None


gdb.pretty_printers.append(zig_pretty_printer)


class ArrayPrinter(object):
    def __init__(self, val):
        self.val = val
        self.length = int(val.type.range()[1]) + 1

    def to_string(self):
        return "<{}>".format(self.val.type)

    def children(self):
        for i in range(self.length):
            yield ("", self.val[i])

    def display_hint(self):
        return "array"


class U8SlicePrinter(object):
    def __init__(self, val):
        self.val = val
        self.pointer = self.val["ptr"]
        self.length = int(self.val["len"])

    def to_string(self):
        decoded = self.pointer.string("utf-8", length = self.length)
        string = bytearray(decoded, "utf-8")

        # NOTE: The string to be printed needs to be the last thing being
        # inserted into the our return string. The way that parsing will work is that
        # when the parser knows it's time to parse the string, instead of immediately
        # reading from the first quote, it will walk the whole slice output in gdb 
        # backwards looking for the first '">' sequence it finds. Once it's found,
        # it knows where the user's string starts and ends. Reason for this is because the 
        # user could have inserted their own '">' sequence and thus breaking parsing.
        return "<{}; \"{}\">".format(self.val.type, string)

    def children(self):
        for i in range(self.length):
            yield ("", (self.pointer + i).dereference())

    def display_hint(self):
        return "array"


class SlicePrinter(object):
    def __init__(self, val):
        self.val = val
        self.pointer = self.val["ptr"]
        self.length = int(self.val["len"])

        # element_bit_length = re.match(r'^struct \[\][u|i](\d)+', str(val.type)).group(1)
        # if element_bit_length not in ['8', '16', '32', '64', '128']:
        #     del(self.children)

    def to_string(self):
        return "<{}>".format(self.val.type)

    def children(self):
        yield ("", "ptr")
        yield ("", "<hex> {}".format(hex(int(self.pointer))))
        yield ("", "len")
        yield ("", "<usize> {}".format(self.length))

        # for i in range(self.length):
        #     yield ("", (self.pointer + i).dereference())

    def display_hint(self):
        return "map"


class StructPrinter(object):
    def __init__(self, val):
        self.val = val

    def to_string(self):
        return "<{}>".format(self.val.type)

    def children(self):
        optional_struct = "?" in str(self.val.type)
        for v in self.val.type.fields():
            # TODO: having issues with the maybe field
            # in a optional struct crashing gdb
            if v.name == "maybe" and optional_struct:
                continue

            yield ("", v.name)

            type_name = str(v.type)
            if v.type.code in [
                gdb.TYPE_CODE_PTR,
                gdb.TYPE_CODE_INT,
                gdb.TYPE_CODE_FLT,
                gdb.TYPE_CODE_BOOL
            ]:
                # These are not expensive to look up, by which I mean
                # that they won't go out recursively defining more data types
                # to look up and print.
                yield ("", "{}".format(self.val[v.name]))
            else:
                # To be more efficient, lets only print out the type of this
                # complex type. Let the programmer ask for the value later.
                # NOTE: ! indicates to the parser that it will need to evaluate
                # this field in order to get its value.
                yield ("", "<{}> = !".format(type_name))

    def display_hint(self):
        return "map"


class FunctionPointerPrinter(object):
    def __init__(self, val):
        self.val = val

    def to_string(self):
        fn_addr = int(self.val)
        return "<fn ptr> = {}".format(hex(fn_addr))
        # fn_symbol = gdb.block_for_pc(fn_addr).function
        # fn_name = fn_symbol.print_name
        # fn_file = fn_symbol.symtab.filename
        # fn_line = fn_symbol.line
        # return "<fn ptr> = {{[addr] = {}, [name] = {}, [file] = {}, [line] = {}}}".format(
        #     hex(fn_addr), fn_name, fn_file, fn_line
        # )


class PointerPrinter(object):
    def __init__(self, val):
        self.val = val

    def to_string(self):
        addr = hex(int(self.val))
        return "<{}> = {}".format(str(self.val.type), addr)

class U8Printer(object):
    def __init__(self, val):
        self.val = val

    def to_string(self):
        return "<{}> {} {}".format(self.val.type, int(self.val), arr)


class NumericPrinter(object):
    def __init__(self, val):
        self.val = val
        self.type_name = str(val.type)

    def to_string(self):
        if self.type_name.startswith('f'):
            num = float(self.val)
        else:
            num = int(self.val)

        return "<{}> {}".format(self.val.type, num)